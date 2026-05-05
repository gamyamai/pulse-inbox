(function () {
  // --- 1. CONFIGURATION ---
  // Support both new encrypted method (window.UniBoxEmbedConfig) and legacy method (window.UniBoxSettings)

  let userConfig = null;

  // Check for new encrypted embed config
  if (globalThis.UniBoxEmbedConfig) {
    try {
      const embedConfig = globalThis.UniBoxEmbedConfig;
      const encryptedConfig = embedConfig.encryptedConfig;

      if (!encryptedConfig) {
        console.error("UniBox: Missing encryptedConfig in embed config.");
        return;
      }

      // Decrypt config using the same fixed key used for encryption
      function decryptConfig(encryptedData, key) {
        try {
          // Decode from base64
          const decoded = atob(encryptedData);
          const keyStr = String(key);
          // XOR decrypt (key bytes cycled)
          let decrypted = "";
          for (let i = 0; i < decoded.length; i++) {
            const k = keyStr.codePointAt(i % keyStr.length);
            decrypted += String.fromCodePoint(decoded.codePointAt(i) ^ k);
          }
          // Decode from base64 to UTF-8 string
          const jsonString = decodeURIComponent(escape(atob(decrypted)));
          return JSON.parse(jsonString);
        } catch (e) {
          console.error("UniBox: Failed to decrypt config", e);
          return null;
        }
      }

      // Use the same encryption key (must match the one used in script generator)
      const encryptionKey = "unibox-widget-encryption-key-2024";
      const decryptedConfig = decryptConfig(encryptedConfig, encryptionKey);

      if (decryptedConfig) {
        userConfig = decryptedConfig;
      } else {
        console.error("UniBox: Failed to decrypt config.");
        return;
      }
    } catch (e) {
      console.error("UniBox: Error processing embed config", e);
      return;
    }
  }
  // Fall back to legacy method
  else if (window.UniBoxSettings) {
    userConfig = window.UniBoxSettings;
  } else {
    console.error(
      "UniBox: Settings missing. Please configure window.UniBoxEmbedConfig or window.UniBoxSettings.",
    );
    return;
  }

  const requiredFields = ["tenantId", "widgetToken", "chatbotId"];
  const missingFields = requiredFields.filter((field) => !userConfig[field]);

  if (missingFields.length > 0) {
    console.error(
      `UniBox: Missing required fields: ${missingFields.join(", ")}`,
    );
    return;
  }

  // Prevent duplicate widget mounts when the embed script is injected twice.
  const INSTANCE_KEY = `${userConfig.tenantId}:${userConfig.chatbotId}`;
  const UNIBOX_INSTANCE_REGISTRY_KEY = "__UNIBOX_WIDGET_INSTANCE_REGISTRY__";
  const uniboxInstanceRegistry =
    globalThis[UNIBOX_INSTANCE_REGISTRY_KEY] ||
    (globalThis[UNIBOX_INSTANCE_REGISTRY_KEY] = new Set());

  if (uniboxInstanceRegistry.has(INSTANCE_KEY)) {
    console.warn(
      "UniBox: Duplicate widget initialization blocked for",
      INSTANCE_KEY,
    );
    return;
  }
  uniboxInstanceRegistry.add(INSTANCE_KEY);

  // Get pulse API URL from config only (no hardcoded host fallback).
  const pulseServiceBase = String(userConfig.pulseServiceBase || "").trim();
  const baseUrl =
    userConfig.apiBaseUrl ||
    userConfig.baseUrl ||
    (pulseServiceBase ? `${pulseServiceBase.replace(/\/+$/, "")}/chat` : "");

  if (!baseUrl) {
    console.error(
      "UniBox: Missing pulse API base URL. Provide apiBaseUrl/baseUrl or pulseServiceBase.",
    );
    return;
  }

  // Storage Keys (using tenantId from userConfig)
  const SESSION_KEY_FORM = `unibox_form_submitted_${userConfig.tenantId}`;
  const SESSION_KEY_FORM_DATA = `unibox_form_data_${userConfig.tenantId}`;
  const SESSION_KEY_FORM_MAPPINGS = `unibox_form_mappings_${userConfig.tenantId}`;
  const STORAGE_KEY_OPEN = `unibox_open_${userConfig.tenantId}`;
  const STORAGE_KEY_USER = `unibox_guest_${userConfig.tenantId}`;
  const STORAGE_KEY_ENGAGEMENT = `unibox_engagement_${userConfig.tenantId}`;

  // API URLs - will be set after we get the full config
  let API_BASE = baseUrl;
  let UTILITY_API_BASE = "";
  let UTILITY_S3_URL = "";
  let SOCKET_CONFIG = { namespaceUrl: "", path: "" };
  let WS_URL = ""; // WebSocket URL for new WebSocket service
  let wsToken = null; // JWT token for WebSocket authentication

  // Utility service URL for media (separate from logo S3)
  // Construct utility base URL from API_BASE host -> /utilities/v1/s3
  // This matches the backend S3 client (`S3_CLIENT_URL`)
  function getUtilityBaseUrl() {
    try {
      const explicitUtilityBase = String(
        userConfig.utilityApiBaseUrl || userConfig.utilityServiceBase || "",
      ).trim();
      if (explicitUtilityBase) {
        const normalized = explicitUtilityBase.replace(/\/+$/, "");
        return normalized.endsWith("/s3") ? normalized : `${normalized}/s3`;
      }
      const urlObj = new URL(API_BASE);
      // Always point to the shared utilities service (independent of /pulse path)
      return `${urlObj.protocol}//${urlObj.host}/utilities/v1/s3`;
    } catch (e) {
      return "";
    }
  }

  function normalizeUtilityS3Base(url) {
    const normalized = String(url || "")
      .trim()
      .replace(/\/+$/, "");
    if (!normalized) return "";
    return normalized.endsWith("/s3") ? normalized : `${normalized}/s3`;
  }

  // Get WebSocket URL from config or construct from API base
  function getWebSocketUrl() {
    try {
      // Check if websocketUrl is provided in fetched config (passed from embed script)
      if (fetchedConfig && fetchedConfig.websocketUrl) {
        console.log(
          "UniBox: Using WebSocket URL from config:",
          fetchedConfig.websocketUrl,
        );
        return fetchedConfig.websocketUrl;
      }

      // Fallback: construct from API_BASE (not recommended, use config)
      console.warn(
        "UniBox: websocketUrl not found in config, constructing from API_BASE",
      );
      const urlObj = new URL(API_BASE);
      // Convert https:// to wss:// and http:// to ws://
      const wsProtocol = urlObj.protocol === "https:" ? "wss:" : "ws:";
      // WebSocket service endpoint
      const constructedUrl = `${wsProtocol}//${urlObj.host}/ws`;
      console.log("UniBox: Constructed WebSocket URL:", constructedUrl);
      return constructedUrl;
    } catch (e) {
      console.error("UniBox: Failed to construct WebSocket URL", e);
      return null;
    }
  }

  // Socket Config Helper
  function getSocketConfig(apiBase) {
    try {
      const urlObj = new URL(apiBase);
      const basePath = urlObj.pathname.replace(/\/chat\/?$/, "");
      return {
        namespaceUrl: `${urlObj.protocol}//${urlObj.host}${basePath}/events`,
        path: `${basePath}/socket.io/`,
      };
    } catch (e) {
      console.error("UniBox: Invalid API URL", e);
      return { namespaceUrl: "", path: "" };
    }
  }

  // Get Config API URL
  function getConfigApiUrl() {
    try {
      const urlObj = new URL(baseUrl);
      let configPath;

      // If pathname contains /pulse/v1/chat, replace it with /pulse/v1/public/chatbot/config
      if (urlObj.pathname.match(/\/pulse\/v1\/chat/)) {
        configPath = urlObj.pathname.replace(
          /\/pulse\/v1\/chat\/?$/,
          "/pulse/v1/public/chatbot/config",
        );
      } else {
        // Otherwise, construct the full path
        configPath = "/pulse/v1/public/chatbot/config";
      }

      const configUrl = `${urlObj.protocol}//${urlObj.host}${configPath}`;
      // Add chatbotId as query parameter
      const urlWithParams = new URL(configUrl);
      urlWithParams.searchParams.set("chatbotId", userConfig.chatbotId);
      return urlWithParams.toString();
    } catch (e) {
      // Fallback if URL parsing fails
      const fallbackUrl = baseUrl.replace(
        /\/pulse\/v1\/chat\/?$/,
        "/pulse/v1/public/chatbot/config",
      );
      return `${fallbackUrl}?chatbotId=${encodeURIComponent(
        userConfig.chatbotId,
      )}`;
    }
  }

  /** Supported font families. Key = stored config value, value = full CSS font-family string. */
  const WIDGET_FONT_FAMILIES = {
    default:
      "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    inter:
      "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    roboto:
      "'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    "open-sans":
      "'Open Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    "segoe-ui":
      "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif",
    "helvetica-neue":
      "'Helvetica Neue', Helvetica, Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    poppins:
      "'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    montserrat:
      "'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    "dm-sans":
      "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    dm_sans:
      "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    nunito:
      "'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    quicksand:
      "'Quicksand', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    comfortaa:
      "'Comfortaa', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    rubik:
      "'Rubik', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    "system-font":
      "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    "system-ui":
      "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    system_ui:
      "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    system:
      "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    // Backward-compat for previously exposed options.
    lato:
      "'Lato', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    figtree:
      "'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    "plus-jakarta-sans":
      "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  };

  function resolveWidgetFont(raw) {
    if (!raw) return WIDGET_FONT_FAMILIES["inter"];
    const key = raw
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/['"]/g, "");
    return WIDGET_FONT_FAMILIES[key] || WIDGET_FONT_FAMILIES[raw] || raw;
  }

  const defaults = {
    tenantId: "",
    apiKey: "",
    widgetToken: "",
    testMode: false,
    appearance: {
      gradientColor1: "#912FF5",
      gradientColor2: "#EF32D4",
      gradientColor3: "#7DBCFE",
      fontFamily: "inter",
      iconStyle: "rounded",
      logoUrl: "",
      headerLogoUrl: "",
      brandLogoUrl: "",
      header: {
        title: "Support",
        welcomeMessage: "Hi there! How can we help?",
        offlineMessage: "We are currently offline.",
      },
      headerName: "Support",
      welcomeMessage: "Hi there! How can we help?",
      chatToggleIcon: {
        style: "rounded",
      },
      bubbleAnimation: "none",
      bubbleSize: "small",
    },
    behavior: {
      botDelayMs: 600,
      typingIndicator: true,
      autoOpen: false,
      autoOpenDelay: 2000,
      stickyPlacement: "bottom-right",
    },
    preChatForm: {
      enabled: false,
      fields: [],
      consentCheckbox: false,
      consentText: "I agree to be contacted.",
    },
    engagementTriggers: {
      proactiveMessage: "",
      triggerCondition: "time",
      triggerValue: 5,
      showOncePerSession: true,
    },
    mobileExperience: {
      mobileWidgetEnabled: true,
      mobileWindowStyle: "fullscreen",
      autoOpenOnMobile: false,
    },
    soundNotifications: {
      newMessageSoundEnabled: false,
      soundType: "ping",
      browserNotificationEnabled: false,
    },
    advancedSettings: {
      persistentChat: true,
      visitorTrackingEnabled: true,
      hideOnPages: [],
      showOnlyOnPages: [],
    },
    installation: {
      allowedDomains: [],
      displayRules: null,
    },
    windowUi: {},
    preview: {},
  };

  // Settings will be initialized after fetching config
  let settings = null;

  // --- 2. STATE ---
  let conversationId = null;
  let socket = null;
  let userId = localStorage.getItem(STORAGE_KEY_USER);
  let resolvedHeaderLogoUrl = "";
  let resolvedBrandLogoUrl = "";
  let resolvedLauncherCustomUrl = "";
  let resolvedAvatarUrl = "";
  let resolvedFontFamily = "";
  let messages = new Map();
  /** Peer (human agent) online — driven by assignment + presence events */
  let isAgentOnline = false;
  let staticWelcomeShown = false;
  let showQuickReplies = true;
  let demoQuickReplies = [];
  let realWelcomeMessageId = null; // Track the real welcome message ID once it replaces static welcome
  let typingTimeout = null;
  let isTyping = false;
  let agentTyping = false;
  let agentTypingTimeout = null; // Timeout for hiding agent typing indicator
  /** Fires after botDelayMs so "Pulse AI" typing only shows once the AI path is likely active */
  let optimisticAiTypingTimer = null;
  let previewMedia = null; // { url, filename, type, mediaKey } - for viewing received media
  let previewMediaRefreshTimer = null;
  // Cache access URLs briefly; refresh before they expire.
  // key -> { url: string, expiresAt: number|null }
  const mediaUrlCache = new Map();
  let previewFile = null; // @deprecated - Not used. Was for single file upload preview modal.
  let selectedFiles = []; // Array of { file, previewUrl, mediaType, fileName } - ACTIVE file upload flow (shows as chips)
  let currentView = "chat";
  let renderView = () => {};
  let activePopupFormConfig = null;
  let popupFormValues = {};
  let popupFormError = "";
  let isSubmittingPopupForm = false;
  let fetchedConfig = null; // Store fetched config for WebSocket URL
  let wsConnectPromise = null; // Promise that resolves when WebSocket is connected
  let wsConnectResolve = null; // Resolver for the connection promise
  let pendingMessages = []; // Queue of messages to send when connection is ready
  let isConnecting = false; // Flag to prevent concurrent connection attempts
  let skipThreadFetchOnNextSocketConnect = false; // Skip history fetch after fresh conversation creation
  let workflowAutoStarted = false; // Prevent duplicate auto-starts of the workflow engine
  let waitingForFirstInboundMessage = true; // Show body loader until first real inbound bot message
  let liveAgentProfileKey = "";
  let liveAgentProfileUrl = "";
  let liveAgentProfileFetchToken = 0;

  function parsePathRuleList(input) {
    if (Array.isArray(input)) {
      return input.map((item) => String(item || "").trim()).filter(Boolean);
    }
    return String(input || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function normalizePathRule(path) {
    if (!path) return "/";
    let normalized = String(path).trim();
    if (!normalized.startsWith("/")) normalized = `/${normalized}`;
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized || "/";
  }

  function pathMatchesRule(currentPath, rule) {
    const normalizedPath = normalizePathRule(currentPath);
    const normalizedRule = normalizePathRule(rule);
    if (normalizedRule === "/") return normalizedPath === "/";
    return (
      normalizedPath === normalizedRule ||
      normalizedPath.startsWith(`${normalizedRule}/`)
    );
  }

  function getAdvancedSettingsConfig() {
    const preview = settings?.preview || {};
    const advanced =
      settings?.advancedSettings ||
      settings?.windowUi?.advancedSettings ||
      settings?.windowUi?.advanced ||
      {};

    const hideOnPages = parsePathRuleList(
      advanced.hideOnPages ??
        advanced.hideChatOnPages ??
        preview.hideOnPages ??
        preview.hideChatOnPages,
    );
    const showOnlyOnPages = parsePathRuleList(
      advanced.showOnlyOnPages ??
        advanced.showChatOnPagesOnly ??
        preview.showOnlyOnPages ??
        preview.showChatOnPagesOnly,
    );

    return {
      persistentChat: advanced.persistentChat ?? preview.persistentChat ?? true,
      visitorTrackingEnabled:
        advanced.visitorTrackingEnabled ??
        preview.visitorTrackingEnabled ??
        true,
      hideOnPages,
      showOnlyOnPages,
    };
  }

  function shouldRenderOnCurrentPath() {
    const currentPath = window.location.pathname || "/";
    const advanced = getAdvancedSettingsConfig();
    if (advanced.showOnlyOnPages.length > 0) {
      return advanced.showOnlyOnPages.some((rule) =>
        pathMatchesRule(currentPath, rule),
      );
    }
    if (advanced.hideOnPages.length > 0) {
      return !advanced.hideOnPages.some((rule) =>
        pathMatchesRule(currentPath, rule),
      );
    }
    return true;
  }

  function resolveAutoTriggerMode() {
    const behavior = settings?.behavior || {};
    const showOnExitIntent = Boolean(behavior.showOnExitIntent);
    const showOnlyAfterScrollPercent = Number(
      behavior.showOnlyAfterScrollPercent ?? 0,
    );
    const autoOpenEnabled = Boolean(behavior.autoOpen);
    const autoOpenDelayMs = Math.max(0, Number(behavior.autoOpenDelay ?? 0));

    if (showOnExitIntent) return "exit-intent";
    if (showOnlyAfterScrollPercent > 0) return "on-scroll";
    if (autoOpenEnabled && autoOpenDelayMs > 0) return "after-delay";
    if (autoOpenEnabled) return "immediately";
    return "none";
  }

  function isMobileViewport() {
    if (typeof window.matchMedia === "function") {
      return window.matchMedia("(max-width: 768px)").matches;
    }
    return window.innerWidth <= 768;
  }

  function getMobileExperienceConfig() {
    const preview = settings?.preview || {};
    const mobile =
      settings?.mobileExperience || settings?.windowUi?.mobileExperience || {};
    return {
      isMobile: isMobileViewport(),
      mobileWidgetEnabled:
        mobile.mobileWidgetEnabled ?? preview.mobileWidgetEnabled ?? true,
      mobileWindowStyle: String(
        mobile.mobileWindowStyle ?? preview.mobileWindowStyle ?? "fullscreen",
      ),
      autoOpenOnMobile:
        mobile.autoOpenOnMobile ?? preview.autoOpenOnMobile ?? false,
    };
  }

  function getEngagementTriggerConfig() {
    const preview = settings?.preview || {};
    const engagement =
      settings?.engagementTriggers ||
      settings?.windowUi?.engagementTriggers ||
      {};
    return {
      proactiveMessage: String(
        engagement.proactiveMessage ?? preview.proactiveMessage ?? "",
      ).trim(),
      triggerCondition: String(
        engagement.triggerCondition ?? preview.triggerCondition ?? "time",
      )
        .trim()
        .toLowerCase(),
      triggerValue: Number(
        engagement.triggerValue ?? preview.triggerValue ?? 0,
      ),
      showOncePerSession:
        engagement.showOncePerSession ?? preview.showOncePerSession ?? true,
    };
  }

  function shouldRenderByInstallationRules() {
    const preview = settings?.preview || {};
    const installation =
      settings?.installation || settings?.windowUi?.installation || {};
    const allowedDomainsRaw =
      installation.allowedDomains ?? preview.allowedDomains ?? [];
    const allowedDomains = parsePathRuleList(allowedDomainsRaw).map((domain) =>
      String(domain)
        .toLowerCase()
        .replace(/^https?:\/\//, ""),
    );

    if (allowedDomains.length > 0) {
      const host = String(window.location.hostname || "").toLowerCase();
      const isAllowed = allowedDomains.some((rule) => {
        const normalizedRule = rule.split("/")[0];
        return host === normalizedRule || host.endsWith(`.${normalizedRule}`);
      });
      if (!isAllowed) return false;
    }

    const displayRules = installation.displayRules ?? preview.displayRules;
    if (!displayRules) return true;

    let showOnly = [];
    let hide = [];
    if (Array.isArray(displayRules)) {
      showOnly = parsePathRuleList(displayRules);
    } else if (typeof displayRules === "object") {
      showOnly = parsePathRuleList(
        displayRules.showOnlyOnPages ??
          displayRules.showOnPagesOnly ??
          displayRules.includePaths,
      );
      hide = parsePathRuleList(
        displayRules.hideOnPages ?? displayRules.excludePaths,
      );
    }

    const currentPath = window.location.pathname || "/";
    if (showOnly.length > 0) {
      const matchedShow = showOnly.some((rule) =>
        pathMatchesRule(currentPath, rule),
      );
      if (!matchedShow) return false;
    }
    if (hide.length > 0) {
      const matchedHide = hide.some((rule) =>
        pathMatchesRule(currentPath, rule),
      );
      if (matchedHide) return false;
    }
    return true;
  }

  function getSoundNotificationConfig() {
    const preview = settings?.preview || {};
    const sound =
      settings?.soundNotifications ||
      settings?.windowUi?.soundNotifications ||
      settings?.windowUi?.sound ||
      {};
    return {
      newMessageSoundEnabled:
        sound.newMessageSoundEnabled ?? preview.newMessageSoundEnabled ?? false,
      soundType: String(sound.soundType ?? preview.soundType ?? "ping"),
      browserNotificationEnabled:
        sound.browserNotificationEnabled ??
        preview.browserNotificationEnabled ??
        false,
    };
  }

  let audioCtx = null;
  function getAudioContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    return audioCtx;
  }

  function playSystemSound(soundType) {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    const beep = (freq, duration, offset, gain = 0.03) => {
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      amp.gain.setValueAtTime(gain, now + offset);
      amp.gain.exponentialRampToValueAtTime(0.0001, now + offset + duration);
      osc.connect(amp);
      amp.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + duration);
    };
    if (soundType === "none") return;
    if (soundType === "chime") {
      beep(1046, 0.16, 0);
      beep(1318, 0.22, 0.12);
    } else {
      beep(880, 0.12, 0);
    }
  }

  function maybeRequestNotificationPermission() {
    const cfg = getSoundNotificationConfig();
    if (!cfg.browserNotificationEnabled) return;
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }

  function maybeNotifyIncomingMessage(title, bodyText) {
    const cfg = getSoundNotificationConfig();
    if (!cfg.browserNotificationEnabled) return;
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    if (!document.hidden) return;
    try {
      new Notification(title || "New message", {
        body: bodyText || "You have a new message",
        tag: `unibox-${userConfig.chatbotId || "chat"}`,
      });
    } catch (e) {
      // no-op
    }
  }

  // --- HELPER: Safe WebSocket Send ---
  /**
   * Safely send a message via WebSocket, only if connection is open
   * If not connected, queues the message for later
   * @param {Object} data - Data to send
   * @param {boolean} queue - If true, queue message if not connected (default: false)
   * @returns {boolean} - true if sent, false if queued or failed
   */
  function wsSend(data, queue = false) {
    if (!socket) {
      if (queue) {
        console.log("UniBox: WebSocket not initialized, queuing message");
        pendingMessages.push(data);
        return false;
      }
      console.warn("UniBox: Cannot send - WebSocket not initialized");
      return false;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      if (queue) {
        console.log("UniBox: WebSocket not open, queuing message");
        pendingMessages.push(data);
        return false;
      }
      console.warn(
        "UniBox: Cannot send - WebSocket not open, readyState:",
        socket.readyState,
      );
      return false;
    }
    try {
      socket.send(JSON.stringify(data));
      return true;
    } catch (error) {
      console.error("UniBox: Failed to send WebSocket message:", error);
      return false;
    }
  }

  /**
   * Wait for WebSocket to be connected
   * @param {number} timeout - Max time to wait in ms (default: 5000)
   * @returns {Promise<boolean>} - true if connected, false if timeout
   */
  async function waitForWsConnection(timeout = 5000) {
    // Already connected
    if (socket && socket.readyState === WebSocket.OPEN) {
      return true;
    }

    // Connection in progress, wait for it
    if (wsConnectPromise) {
      try {
        await Promise.race([
          wsConnectPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), timeout),
          ),
        ]);
        return socket && socket.readyState === WebSocket.OPEN;
      } catch (e) {
        return false;
      }
    }

    // No connection in progress
    return false;
  }

  /**
   * Flush pending messages after connection is established
   */
  function flushPendingMessages() {
    if (pendingMessages.length === 0) return;

    console.log("UniBox: Flushing", pendingMessages.length, "pending messages");
    const messages = [...pendingMessages];
    pendingMessages = [];

    messages.forEach((data) => {
      wsSend(data);
    });
  }

  /**
   * Subscribe to a conversation via WebSocket
   * Only subscribes if we have a valid conversationId and socket is open
   */
  // Track if we've subscribed to avoid duplicate subscriptions
  let subscribedConversationId = null;

  /** After live handoff, virtual agent display name from WebSocket; cleared on new/ended session. */
  let liveAgentDisplayName = null;
  /** After live handoff, agent principal id from WebSocket; used for platform linkage. */
  let liveAgentId = null;
  /**
   * True only after explicit human live-chat handoff WebSocket events — not when the
   * thread merely has an assignedAgentName (workflow / AI persona). Used for typing
   * logic so named bots still get optimistic + server AI typing indicators.
   */
  let humanLiveAgentHandoff = false;
  /** Launcher badge for unseen inbound events while chat is closed. */
  let launcherEventBadgeVisible = false;

  /**
   * Chat window title from appearance (embed / API), not the live agent name.
   */
  function resolveChatWindowTitleForUi() {
    const a = settings && settings.appearance;
    if (!a) return "Support Chat";
    const t = String(a.headerName || a.header?.title || "").trim();
    return t || "Support Chat";
  }

  /**
   * Agent row label: assigned virtual agent after handoff, otherwise "Pulse AI".
   */
  function resolveAgentTitleForUi() {
    return liveAgentDisplayName || "Pulse AI";
  }

  function isLiveAgentAssigned() {
    return Boolean(liveAgentDisplayName || liveAgentId);
  }

  function clearLiveAgentDisplayName() {
    liveAgentDisplayName = null;
    liveAgentId = null;
    humanLiveAgentHandoff = false;
    liveAgentProfileKey = "";
    liveAgentProfileUrl = "";
    liveAgentProfileFetchToken++;
    isAgentOnline = false;
    syncAgentTitleUi();
  }

  function setLiveAgentDisplayName(name) {
    if (!name || typeof name !== "string") return;
    const t = name.trim();
    if (!t) return;
    liveAgentDisplayName = t;
    // Human handoff: suppress optimistic bot typing; rely on explicit agent typing events.
    if (humanLiveAgentHandoff) {
      clearOptimisticAiTypingSchedule();
      if (agentTypingTimeout) {
        clearTimeout(agentTypingTimeout);
        agentTypingTimeout = null;
      }
      agentTyping = false;
      showTypingIndicator(false);
    }
    syncAgentTitleUi();
  }

  function setLiveAgentId(agentId) {
    if (agentId == null) return;
    const t = String(agentId).trim();
    if (!t) return;
    liveAgentId = t;
    if (humanLiveAgentHandoff) {
      clearOptimisticAiTypingSchedule();
      if (agentTypingTimeout) {
        clearTimeout(agentTypingTimeout);
        agentTypingTimeout = null;
      }
      agentTyping = false;
      showTypingIndicator(false);
    }
    syncAgentTitleUi();
  }

  function getNameInitials(name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return "AG";
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  const SOFT_AVATAR_COLORS = [
    { bg: "#DDD6FE", text: "#8D53F8" },
    { bg: "#FECACA", text: "#B91C1C" },
    { bg: "#BFDBFE", text: "#1D4ED8" },
    { bg: "#C7D2FE", text: "#4338CA" },
    { bg: "#A5F3FC", text: "#0E7490" },
    { bg: "#FED7AA", text: "#C2410C" },
    { bg: "#BBF7D0", text: "#15803D" },
    { bg: "#FBCFE8", text: "#BE185D" },
    { bg: "#FEF08A", text: "#A16207" },
    { bg: "#99F6E4", text: "#0F766E" },
  ];

  function hashName(name) {
    let hash = 0;
    const raw = String(name || "");
    for (let i = 0; i < raw.length; i++) {
      hash = (raw.codePointAt(i) || 0) + ((hash << 5) - hash);
    }
    return Math.abs(hash);
  }

  function getHeaderAvatarFallbackStyle(name) {
    const color = SOFT_AVATAR_COLORS[hashName(name) % SOFT_AVATAR_COLORS.length];
    return `background:${color.bg};color:${color.text};font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;font-family:'DM Sans',sans-serif;`;
  }

  function renderHeaderAgentProfile() {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const profileWrap = host.shadowRoot.getElementById("chatHeaderAgentProfile");
    if (!profileWrap) return;
    if (!isLiveAgentAssigned()) {
      profileWrap.classList.add("hidden");
      profileWrap.innerHTML = "";
      return;
    }

    profileWrap.classList.remove("hidden");
    const label = liveAgentDisplayName || "Agent";
    if (liveAgentProfileUrl) {
      profileWrap.innerHTML = `<img src="${liveAgentProfileUrl}" class="chat-widget-header-agent-profile" alt="${escapeHtmlWidget(label)}" />`;
      return;
    }
    const initials = getNameInitials(label);
    const fallbackStyle = getHeaderAvatarFallbackStyle(label);
    profileWrap.innerHTML = `<div class="chat-widget-header-agent-profile chat-widget-header-agent-profile-fallback" aria-label="${escapeHtmlWidget(label)}" style="${fallbackStyle}">${escapeHtmlWidget(initials)}</div>`;
  }

  async function setLiveAgentProfileKey(profileKey) {
    const nextKey = String(profileKey || "").trim();
    liveAgentProfileKey = nextKey;
    liveAgentProfileUrl = "";
    const fetchToken = ++liveAgentProfileFetchToken;
    renderHeaderAgentProfile();
    if (!nextKey) return;
    const isDirectUrl =
      /^https?:\/\//i.test(nextKey) || /^data:image\//i.test(nextKey);
    const resolved = isDirectUrl ? nextKey : await fetchLogoUrl(nextKey);
    if (fetchToken !== liveAgentProfileFetchToken) return;
    liveAgentProfileUrl = resolved || "";
    renderHeaderAgentProfile();
  }

  function setLauncherEventBadgeVisible(visible) {
    launcherEventBadgeVisible = Boolean(visible);
    const host = document.getElementById("unibox-root");
    const badge = host?.shadowRoot?.getElementById("launcherEventBadge");
    if (!badge) return;
    if (launcherEventBadgeVisible) badge.classList.remove("hidden");
    else badge.classList.add("hidden");
  }

  function extractVirtualAgentDisplayName(evt) {
    if (!evt || typeof evt !== "object") return null;
    const flat =
      evt.payload && typeof evt.payload === "object"
        ? Object.assign({}, evt, evt.payload)
        : evt;
    const n =
      flat.agentName ??
      flat.agent_name ??
      flat.displayName ??
      flat.agent_display_name ??
      flat.virtualAgentName ??
      flat.assignedAgentName ??
      flat.virtual_agent_name ??
      flat.userName ??
      flat.fullName ??
      flat.full_name ??
      flat.profileName ??
      flat.profile_name ??
      flat.principalName ??
      flat.principal_name ??
      (flat.user && (flat.user.name || flat.user.displayName)) ??
      (flat.profile && (flat.profile.name || flat.profile.displayName)) ??
      (flat.agent && (flat.agent.name || flat.agent.displayName)) ??
      (flat.assignedAgent &&
        (flat.assignedAgent.name || flat.assignedAgent.displayName)) ??
      (flat.assigned_to &&
        (typeof flat.assigned_to === "string"
          ? flat.assigned_to
          : flat.assigned_to.name || flat.assigned_to.displayName));
    if (typeof n !== "string") return null;
    const t = n.trim();
    return t.length ? t : null;
  }

  function extractVirtualAgentId(evt) {
    if (!evt || typeof evt !== "object") return null;
    const flat =
      evt.payload && typeof evt.payload === "object"
        ? Object.assign({}, evt, evt.payload)
        : evt;
    const id =
      flat.agentId ??
      flat.agent_id ??
      flat.virtualAgentId ??
      flat.virtual_agent_id ??
      flat.assignedAgentId ??
      flat.assigned_agent_id ??
      flat.principalId ??
      flat.principal_id ??
      (flat.agent && (flat.agent.id || flat.agent.agentId)) ??
      (flat.assignedAgent &&
        (flat.assignedAgent.id || flat.assignedAgent.agentId)) ??
      (flat.assigned_to &&
        (typeof flat.assigned_to === "string"
          ? null
          : flat.assigned_to.id || flat.assigned_to.agentId));
    if (id == null) return null;
    const t = String(id).trim();
    return t || null;
  }

  function extractVirtualAgentProfileKey(evt) {
    if (!evt || typeof evt !== "object") return null;
    const flat =
      evt.payload && typeof evt.payload === "object"
        ? Object.assign({}, evt, evt.payload)
        : evt;
    const profileKey =
      flat.agentProfileUrl ??
      flat.agent_profile_url ??
      flat.agentAvatarUrl ??
      flat.agent_avatar_url ??
      flat.avatarUrl ??
      flat.avatar_url ??
      flat.agentProfileKey ??
      flat.agent_profile_key ??
      flat.profileKey ??
      flat.profile_key ??
      flat.avatarKey ??
      flat.avatar_key ??
      (flat.agent &&
        (flat.agent.profileUrl ||
          flat.agent.profile_url ||
          flat.agent.avatarUrl ||
          flat.agent.avatar_url ||
          flat.agent.profileKey ||
          flat.agent.profile_key ||
          flat.agent.avatarKey ||
          flat.agent.avatar_key)) ??
      (flat.assignedAgent &&
        (flat.assignedAgent.profileUrl ||
          flat.assignedAgent.profile_url ||
          flat.assignedAgent.avatarUrl ||
          flat.assignedAgent.avatar_url ||
          flat.assignedAgent.profileKey ||
          flat.assignedAgent.profile_key ||
          flat.assignedAgent.avatarKey ||
          flat.assignedAgent.avatar_key)) ??
      (flat.assigned_to &&
        typeof flat.assigned_to === "object" &&
        (flat.assigned_to.profileUrl ||
          flat.assigned_to.profile_url ||
          flat.assigned_to.avatarUrl ||
          flat.assigned_to.avatar_url ||
          flat.assigned_to.profileKey ||
          flat.assigned_to.profile_key ||
          flat.assigned_to.avatarKey ||
          flat.assigned_to.avatar_key));
    if (typeof profileKey !== "string") return null;
    const t = profileKey.trim();
    return t || null;
  }

  /**
   * Apply agent identity when the payload targets the active conversation (or omits conversation id).
   */
  function maybeApplyVirtualAgentFromEvent(evt, eventConversationId) {
    const name = extractVirtualAgentDisplayName(evt);
    const id = extractVirtualAgentId(evt);
    const profileKey = extractVirtualAgentProfileKey(evt);
    if (!name && !id && !profileKey) return;
    if (
      eventConversationId &&
      conversationId &&
      String(eventConversationId) !== String(conversationId)
    ) {
      return;
    }
    if (name) setLiveAgentDisplayName(name);
    if (id) setLiveAgentId(id);
    if (profileKey !== null) void setLiveAgentProfileKey(profileKey);
  }

  function maybeApplyVirtualAgentFromConversation(conversation) {
    if (!conversation || typeof conversation !== "object") return;
    const assigned =
      conversation.assignedAgent && typeof conversation.assignedAgent === "object"
        ? conversation.assignedAgent
        : null;
    const assignment =
      conversation.assignment && typeof conversation.assignment === "object"
        ? conversation.assignment
        : null;

    const hydrated = {
      agentId:
        (assigned && (assigned.id || assigned.agentId || assigned.agent_id)) ||
        (assignment && (assignment.agent_id || assignment.agentId)) ||
        null,
      agentName:
        (assigned && (assigned.name || assigned.displayName)) ||
        conversation.assignedAgentName ||
        null,
      agentProfileKey:
        (assigned &&
          (assigned.profileKey ||
            assigned.profile_key ||
            assigned.avatarKey ||
            assigned.avatar_key)) ||
        null,
      conversationId: conversation.id || conversation.conversationId || null,
    };
    maybeApplyVirtualAgentFromEvent(hydrated, hydrated.conversationId);
  }

  /**
   * Live agent assignment: update bot message labels (Pulse AI → agent name).
   * No additional in-thread handoff UI is rendered.
   */
  function handleAgentAssignmentHandshake(evt, rawEnvelope) {
    const convId =
      evt?.conversationId ??
      evt?.conversation_id ??
      rawEnvelope?.conversationId ??
      rawEnvelope?.conversation_id;

    if (convId && conversationId && String(convId) !== String(conversationId)) {
      return;
    }

    maybeApplyVirtualAgentFromEvent(evt, convId);
    isAgentOnline = true;
    refreshHeaderPresence();
  }

  function syncAgentTitleUi() {
    const windowTitle = resolveChatWindowTitleForUi();
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const headerEl = host.shadowRoot.getElementById("chatHeaderTitle");
    if (headerEl) headerEl.textContent = windowTitle;
    const scrollWrap = host.shadowRoot.querySelector(".chat-widget-scroll-wrap");
    if (scrollWrap) {
      scrollWrap.classList.toggle(
        "chat-widget-scroll-wrap--live-agent",
        isLiveAgentAssigned(),
      );
    }
    const poweredByEl = host.shadowRoot.querySelector(".chat-widget-powered-by");
    if (poweredByEl) {
      poweredByEl.style.display = isLiveAgentAssigned() ? "none" : "";
    }
    renderHeaderAgentProfile();
    refreshHeaderPresence();
  }

  function subscribeToConversation(convId) {
    if (!convId || convId.startsWith("guest_") || convId.startsWith("user_")) {
      console.log("UniBox: Invalid conversationId for subscription:", convId);
      return false;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.log(
        "UniBox: Socket not open, cannot subscribe. State:",
        socket?.readyState,
      );
      return false;
    }

    // Avoid duplicate subscriptions
    if (subscribedConversationId === convId) {
      console.log("UniBox: Already subscribed to conversation:", convId);
      return true;
    }

    console.log("UniBox: Subscribing to conversation:", convId);
    socket.send(
      JSON.stringify({
        action: "subscribe",
        conversationId: convId,
      }),
    );
    subscribedConversationId = convId;
    return true;
  }

  // --- 3. HELPER: HEADERS ---
  function getHeaders() {
    if (!settings) {
      console.error("UniBox: Settings not initialized");
      return {
        "Content-Type": "application/json",
        "x-tenant-id": userConfig.tenantId,
        "x-api-key": userConfig.apiKey || userConfig.widgetToken, // General API key
        "x-chatbot-token": userConfig.widgetToken, // Widget-specific token
      };
    }
    return {
      "Content-Type": "application/json",
      "x-tenant-id": settings.tenantId,
      "x-api-key": settings.apiKey || settings.widgetToken, // General API key
      "x-chatbot-token": settings.widgetToken, // Widget-specific token
    };
  }

  // --- 4. HELPER: UI LOADING STATE ---
  function setLoading(isLoading) {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById("chatBody");
    if (!body) return;

    if (isLoading) {
      body.innerHTML = `
        <div class="chat-widget-loader">
          <div class="chat-widget-loader-spinner"></div>
        </div>
      `;
    } else {
      const loader = body.querySelector(".chat-widget-loader");
      if (loader) loader.remove();
    }
  }

  function isRealInboundBotMessage(sender, messageId) {
    const id = String(messageId || "");
    return (
      sender === "agent" &&
      !id.startsWith("static_welcome_") &&
      !id.startsWith("temp_")
    );
  }

  function setInitialBodyLoading(isLoading) {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById("chatBody");
    if (!body) return;

    let loader = body.querySelector("#initialBodyLoader");
    if (isLoading) {
      if (!loader) {
        loader = document.createElement("div");
        loader.id = "initialBodyLoader";
        loader.className = "chat-widget-initial-loader";
        loader.innerHTML = `
          <div class="chat-widget-initial-loader-spinner" role="status" aria-label="Loading"></div>
        `;
        body.appendChild(loader);
      }
    } else if (loader) {
      loader.remove();
    }
  }

  function removeWidgetRoot() {
    const instanceHosts = document.querySelectorAll(
      `#unibox-root[data-unibox-instance="${INSTANCE_KEY}"]`,
    );
    if (instanceHosts.length > 0) {
      instanceHosts.forEach((hostNode) => hostNode.remove());
      return;
    }

    // Backward compatibility cleanup for older mounts without data attribute.
    const legacyHosts = document.querySelectorAll("#unibox-root");
    legacyHosts.forEach((hostNode) => hostNode.remove());
  }

  // --- 6. FETCH CONFIG FROM API ---
  /**
   * Fetch widget configuration from the API
   * @returns {Promise<Object>} - The fetched configuration
   */
  async function fetchWidgetConfig() {
    const configApiUrl = getConfigApiUrl();
    const origin = window.location.origin;
    const referer = window.location.href;

    try {
      const response = await fetch(configApiUrl, {
        method: "GET",
        headers: {
          "x-api-key": userConfig.apiKey || userConfig.widgetToken, // General API key, fallback to widgetToken
          "x-chatbot-token": userConfig.widgetToken, // Widget-specific token
          "x-tenant-id": userConfig.tenantId,
          origin: origin,
          referer: referer,
        },
      });

      if (!response.ok) {
        let errorBody = null;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = { message: await response.text() };
        }
        const msg = errorBody?.message || "";
        const statusCode = response.status;

        if (statusCode === 403 && msg.includes("domain is not authorized")) {
          console.warn(
            "UniBox: This domain is not authorized to load the chatbot widget.",
          );
          return null;
        }
        if (statusCode === 404) {
          if (
            msg.includes("Chatbot is not active") ||
            msg.includes("Chatbot not found")
          ) {
            console.warn("UniBox:", msg);
            return null;
          }
        }

        throw new Error(`Failed to fetch config: ${statusCode} - ${msg}`);
      }

      const apiResponse = await response.json();

      // Only load widget when backend explicitly reports success.
      // Any non-success payload should prevent rendering altogether.
      if (apiResponse && apiResponse.success === false) {
        const errorMessage =
          apiResponse?.message || "Widget config response was not successful";
        console.warn("UniBox:", errorMessage);
        return null;
      }

      const apiConfig =
        apiResponse &&
        typeof apiResponse === "object" &&
        apiResponse.data &&
        typeof apiResponse.data === "object"
          ? apiResponse.data
          : apiResponse;

      // ── Normalised sub-objects from the API response ─────────────────────────
      // The API can return config in two shapes:
      //   • Legacy flat fields:  widgetAppearance, widgetBehavior, preChatForm …
      //   • Structured windowUi: windowUi.appearance, .launcher, .position,
      //                          .layout, .behavior, .messages, .engagementTriggers …
      // We always prefer the structured windowUi sub-keys when available so that
      // the widget always reflects the most recent server-side config without any
      // encrypted snapshot dependency.
      const widgetBehaviorApi = apiConfig.widgetBehavior || {};
      const windowUiApi = apiConfig.windowUi || {};
      const windowUiAppearance = windowUiApi.appearance || {};
      const launcherFromWindowUi = windowUiApi.launcher || {};
      const windowUiPosition = windowUiApi.position || {};
      const windowUiLayout = windowUiApi.layout || {};
      const windowUiBehavior = windowUiApi.behavior || {};
      const windowUiMessages = windowUiApi.messages || {};
      const windowUiEngagement =
        windowUiApi.engagementTriggers ||
        widgetBehaviorApi.windowEngagementTriggers ||
        {};
      const windowUiMobile =
        windowUiApi.mobileExperience ||
        widgetBehaviorApi.windowMobileExperience ||
        {};
      const windowUiSound =
        windowUiApi.soundNotifications ||
        widgetBehaviorApi.windowSoundNotifications ||
        {};
      const windowUiAdvanced =
        windowUiApi.advancedSettings ||
        widgetBehaviorApi.windowAdvancedSettings ||
        {};
      const windowUiInstallation = windowUiApi.installation || {};
      const widgetAppearanceApi = apiConfig.widgetAppearance || {};
      const startFlowFromBotFlow = resolveStartFlowFromBotFlow(apiConfig.botFlow);
      const initialFlowFromApi = normalizeFlowPayload(apiConfig.initialFlow);
      const initialFollowUpMessagesFromApi = Array.isArray(
        apiConfig.initialFollowUpMessages,
      )
        ? apiConfig.initialFollowUpMessages
            .map((item) => {
              if (!item || typeof item !== "object") return null;
              const text = String(item.text || "").trim();
              const flow = normalizeFlowPayload(item.flow);
              if (!text && !flow) return null;
              return { text, flow };
            })
            .filter(Boolean)
        : [];
      const hasFollowUpOptionsFromApi = initialFollowUpMessagesFromApi.some(
        (msg) =>
          msg &&
          msg.flow &&
          Array.isArray(msg.flow.options) &&
          msg.flow.options.length > 0,
      );
      const initialFlowWithoutDuplicateOptions =
        hasFollowUpOptionsFromApi &&
        initialFlowFromApi &&
        initialFlowFromApi.nodeType === "message"
          ? {
              ...initialFlowFromApi,
              options: [],
            }
          : initialFlowFromApi;
      const flowWelcomeMessage =
        (startFlowFromBotFlow?.welcomeText &&
        typeof startFlowFromBotFlow.welcomeText === "string" &&
        startFlowFromBotFlow.welcomeText.trim()
          ? startFlowFromBotFlow.welcomeText.trim()
          : "") ||
        (typeof apiConfig.flowWelcomeMessage === "string" &&
        apiConfig.flowWelcomeMessage.trim()
          ? apiConfig.flowWelcomeMessage.trim()
          : "");

      // Normalise launcher icon type (chat | message | custom)
      const launcherIconTypeRaw = String(
        widgetAppearanceApi.launcherIconType ||
          launcherFromWindowUi.launcherIconType ||
          "chat",
      );
      const normLauncherIconType =
        launcherIconTypeRaw === "message"
          ? "message"
          : launcherIconTypeRaw === "custom" || launcherIconTypeRaw === "brand"
            ? "custom"
            : "chat";

      // Merge appearance – always include launcher fields from windowUi.launcher
      // so they are available for renderWidget regardless of which API shape is used.
      const mergedAppearance = {
        ...(widgetAppearanceApi || defaults.appearance),
        // Merge windowUi.appearance colour overrides when present
        primaryColor:
          widgetAppearanceApi.primaryColor || windowUiAppearance.primaryColor,
        secondaryColor:
          widgetAppearanceApi.secondaryColor ||
          windowUiAppearance.secondaryColor,
        brandLogoUrl:
          widgetAppearanceApi.brandLogoUrl || windowUiAppearance.brandLogoUrl,
        // Launcher fields – prefer widgetAppearance, fall back to windowUi.launcher
        launcherIconType: normLauncherIconType,
        launcherIconUrl:
          widgetAppearanceApi.launcherIconUrl ||
          launcherFromWindowUi.launcherIconUrl ||
          undefined,
        launcherType:
          widgetAppearanceApi.launcherType ||
          launcherFromWindowUi.launcherType ||
          undefined,
        launcherText:
          widgetAppearanceApi.launcherText ||
          launcherFromWindowUi.launcherText ||
          undefined,
        bubbleAnimation:
          widgetAppearanceApi.bubbleAnimation ||
          launcherFromWindowUi.bubbleAnimation ||
          undefined,
        bubbleSize:
          widgetAppearanceApi.bubbleSize ||
          launcherFromWindowUi.bubbleSize ||
          undefined,
        // Chat window title / header name from layout
        headerName:
          widgetAppearanceApi.headerName ||
          windowUiLayout.chatWindowTitle ||
          undefined,
        // Header / welcome messages from windowUi.messages
        header: {
          ...(widgetAppearanceApi.header || {}),
          title:
            windowUiLayout.chatWindowTitle ||
            (widgetAppearanceApi.header || {}).title ||
            "",
          subtitle: windowUiLayout.subtitle || "",
          welcomeMessage:
            flowWelcomeMessage ||
            windowUiMessages.welcomeMessage ||
            (widgetAppearanceApi.header || {}).welcomeMessage ||
            "",
          offlineMessage:
            windowUiMessages.offlineMessage ||
            (widgetAppearanceApi.header || {}).offlineMessage ||
            "",
          greetingByTime: Boolean(windowUiMessages.greetingByTime),
          botIntroductionMessage: windowUiMessages.botIntroductionMessage || "",
          fallbackMessage: windowUiMessages.fallbackMessage || "",
        },
        // Top-level welcome message for the chat view
        welcomeMessage:
          flowWelcomeMessage ||
          windowUiMessages.welcomeMessage ||
          widgetAppearanceApi.welcomeMessage ||
          undefined,
        headerLogoUrl:
          widgetAppearanceApi.headerLogoUrl ||
          windowUiLayout.headerLogoUrl ||
          "",
        chatAvatarUrl:
          widgetAppearanceApi.chatAvatarUrl ||
          windowUiLayout.chatAvatarUrl ||
          "",
      };

      // Build the preview snapshot that renderWidget reads for layout/visual values.
      // This replaces the old "encrypted preview payload" approach: now it is always
      // derived from the live API response so any admin change is instantly reflected.
      const normalizedPreview = {
        // Colors
        primaryColor:
          widgetAppearanceApi.primaryColor ||
          windowUiAppearance.primaryColor ||
          defaults.appearance.gradientColor1,
        secondaryColor:
          widgetAppearanceApi.secondaryColor ||
          windowUiAppearance.secondaryColor ||
          defaults.appearance.gradientColor2,
        chatBubbleColor:
          widgetAppearanceApi.chatBubbleColor ||
          windowUiAppearance.chatBubbleColor ||
          "#ECE1FF",
        agentMessageColor:
          widgetAppearanceApi.agentMessageColor ||
          windowUiAppearance.agentMessageColor ||
          "#ECEFF1",
        backgroundColor:
          widgetAppearanceApi.backgroundColor ||
          windowUiAppearance.backgroundColor ||
          "#FFFFFF",
        // Typography
        fontSize: widgetAppearanceApi.fontSize || "small",
        // Launcher
        launcherType:
          widgetAppearanceApi.launcherType ||
          launcherFromWindowUi.launcherType ||
          "bubble",
        launcherIconType: normLauncherIconType,
        launcherText:
          widgetAppearanceApi.launcherText ||
          launcherFromWindowUi.launcherText ||
          "",
        launcherIconUrl:
          widgetAppearanceApi.launcherIconUrl ||
          launcherFromWindowUi.launcherIconUrl ||
          "",
        bubbleAnimation:
          widgetAppearanceApi.bubbleAnimation ||
          launcherFromWindowUi.bubbleAnimation ||
          "none",
        bubbleSize:
          widgetAppearanceApi.bubbleSize ||
          launcherFromWindowUi.bubbleSize ||
          "small",
        // Position
        rightMarginPx: Number(
          widgetBehaviorApi.rightMarginPx ??
            windowUiPosition.rightMarginPx ??
            20,
        ),
        bottomMarginPx: Number(
          widgetBehaviorApi.bottomMarginPx ??
            windowUiPosition.bottomMarginPx ??
            20,
        ),
        zIndex: Number(
          widgetBehaviorApi.zIndex ?? windowUiPosition.zIndex ?? 9999,
        ),
        // Layout
        subtitle: String(windowUiLayout.subtitle || "").trim(),
        windowSize:
          widgetAppearanceApi.windowSize ||
          windowUiLayout.windowSize ||
          "medium",
        windowStyle:
          widgetAppearanceApi.windowStyle ||
          windowUiLayout.windowStyle ||
          "rounded",
        chatAvatarUrl:
          widgetAppearanceApi.chatAvatarUrl ||
          windowUiLayout.chatAvatarUrl ||
          "",
        headerLogoUrl:
          widgetAppearanceApi.headerLogoUrl ||
          windowUiLayout.headerLogoUrl ||
          "",
        brandLogoUrl:
          widgetAppearanceApi.brandLogoUrl ||
          windowUiAppearance.brandLogoUrl ||
          "",
        // Messages
        greetingByTime: Boolean(windowUiMessages.greetingByTime),
        botIntroductionMessage: String(
          windowUiMessages.botIntroductionMessage || "",
        ),
        quickReplyOptions: Array.isArray(windowUiMessages.quickReplyOptions)
          ? windowUiMessages.quickReplyOptions
              .map((opt) => String(opt || "").trim())
              .filter(Boolean)
          : [],
        demoFlow:
          (windowUiMessages.demoFlow &&
          typeof windowUiMessages.demoFlow === "object"
            ? windowUiMessages.demoFlow
            : null) ||
          (windowUiApi.demoFlow && typeof windowUiApi.demoFlow === "object"
            ? windowUiApi.demoFlow
            : null),
        offlineMessage: String(windowUiMessages.offlineMessage || ""),
        fallbackMessage: String(windowUiMessages.fallbackMessage || ""),
        // Engagement triggers
        proactiveMessage: String(windowUiEngagement.proactiveMessage || ""),
        triggerCondition: String(windowUiEngagement.triggerCondition || "time"),
        triggerValue: Number(windowUiEngagement.triggerValue || 0),
        showOncePerSession: Boolean(
          windowUiEngagement.showOncePerSession ?? true,
        ),
        // Mobile
        mobileWidgetEnabled: Boolean(
          windowUiMobile.mobileWidgetEnabled ?? true,
        ),
        mobileWindowStyle: String(
          windowUiMobile.mobileWindowStyle || "fullscreen",
        ),
        autoOpenOnMobile: Boolean(windowUiMobile.autoOpenOnMobile),
        // Sound
        newMessageSoundEnabled: Boolean(windowUiSound.newMessageSoundEnabled),
        soundType: String(windowUiSound.soundType || "ping"),
        browserNotificationEnabled: Boolean(
          windowUiSound.browserNotificationEnabled,
        ),
        // Advanced
        persistentChat: Boolean(windowUiAdvanced.persistentChat ?? true),
        visitorTrackingEnabled: Boolean(
          windowUiAdvanced.visitorTrackingEnabled ?? true,
        ),
        hideOnPages:
          windowUiAdvanced.hideOnPages ||
          apiConfig.advancedSettings?.hideOnPages ||
          [],
        showOnlyOnPages:
          windowUiAdvanced.showOnlyOnPages ||
          apiConfig.advancedSettings?.showOnlyOnPages ||
          [],
        hideChatOnPages:
          windowUiAdvanced.hideChatOnPages ||
          apiConfig.advancedSettings?.hideChatOnPages ||
          "",
        showChatOnPagesOnly:
          windowUiAdvanced.showChatOnPagesOnly ||
          apiConfig.advancedSettings?.showChatOnPagesOnly ||
          "",
        // Installation
        allowedDomains: windowUiInstallation.allowedDomains || [],
      };

      const transformedConfig = {
        tenantId: userConfig.tenantId,
        widgetToken: userConfig.widgetToken,
        apiKey: userConfig.apiKey || userConfig.widgetToken,
        testMode: userConfig.testMode || false,
        // Pass both service base URLs through so UTILITY_API_BASE can be set
        // from fetchedConfig without depending solely on userConfig.
        utilityApiBaseUrl:
          userConfig.utilityApiBaseUrl || userConfig.utilityServiceBase || "",
        pulseServiceBase: userConfig.pulseServiceBase || "",
        // Preserve websocketUrl from userConfig (passed from embed script)
        websocketUrl: userConfig.websocketUrl,
        appearance: mergedAppearance,
        behavior: {
          ...defaults.behavior,
          ...widgetBehaviorApi,
          // Normalise field names that differ between API shapes:
          // windowUi.behavior uses camelCase "enabled/Seconds" suffixes.
          autoOpen:
            widgetBehaviorApi.autoOpen ??
            windowUiBehavior.autoOpenEnabled ??
            defaults.behavior.autoOpen,
          autoOpenDelay:
            widgetBehaviorApi.autoOpenDelay ??
            (windowUiBehavior.autoOpenDelaySeconds != null
              ? Number(windowUiBehavior.autoOpenDelaySeconds) * 1000
              : null) ??
            defaults.behavior.autoOpenDelay,
          showOnlyAfterScrollPercent:
            widgetBehaviorApi.showOnlyAfterScrollPercent ??
            windowUiBehavior.showOnlyAfterScrollPercent ??
            widgetBehaviorApi.triggerRules?.scrollPercentage ??
            0,
          showOnExitIntent:
            widgetBehaviorApi.showOnExitIntent ??
            windowUiBehavior.showOnExitIntent ??
            false,
          stickyPlacement:
            widgetBehaviorApi.stickyPlacement ||
            // windowUi.position uses "bottom_right" (underscore); normalise to dash
            String(windowUiPosition.widgetPosition || "bottom-right").replace(
              /_/g,
              "-",
            ),
          botDelayMs:
            widgetBehaviorApi.botDelayMs ?? defaults.behavior.botDelayMs,
          typingIndicator:
            widgetBehaviorApi.typingIndicator ??
            defaults.behavior.typingIndicator,
        },
        preChatForm:
          apiConfig.preChatForm ||
          (windowUiApi.preChatForm
            ? {
                enabled: Boolean(windowUiApi.preChatForm.enabled),
                fields: (windowUiApi.preChatForm.fields || []).map((f) => ({
                  id: f.id || f.name,
                  name: f.name || f.id,
                  label: f.label,
                  type: f.type,
                  required: Boolean(f.required),
                  customQuestion: f.customQuestion || null,
                })),
                consentCheckbox: Boolean(
                  windowUiApi.preChatForm.consentCheckbox,
                ),
                consentText:
                  windowUiApi.preChatForm.consentText ||
                  "I agree to be contacted.",
              }
            : defaults.preChatForm),
        engagementTriggers:
          apiConfig.engagementTriggers ||
          (Object.keys(windowUiEngagement).length
            ? windowUiEngagement
            : defaults.engagementTriggers),
        mobileExperience:
          apiConfig.mobileExperience ||
          (Object.keys(windowUiMobile).length
            ? windowUiMobile
            : defaults.mobileExperience),
        soundNotifications:
          apiConfig.soundNotifications ||
          (Object.keys(windowUiSound).length
            ? windowUiSound
            : defaults.soundNotifications),
        advancedSettings:
          apiConfig.advancedSettings ||
          (Object.keys(windowUiAdvanced).length
            ? windowUiAdvanced
            : defaults.advancedSettings),
        installation:
          apiConfig.installation ||
          (Object.keys(windowUiInstallation).length
            ? windowUiInstallation
            : defaults.installation),
        windowUi: apiConfig.windowUi || {},
        // preview is now always built from live API data — no encrypted snapshot needed
        preview: normalizedPreview,
        // Store additional config that might be useful
        botFlow: apiConfig.botFlow,
        initialFlow:
          initialFlowWithoutDuplicateOptions || startFlowFromBotFlow?.flow || null,
        initialFollowUpMessages: initialFollowUpMessagesFromApi,
        defaultLanguage: apiConfig.defaultLanguage,
        timezone: apiConfig.timezone,
      };

      return transformedConfig;
    } catch (error) {
      console.error("UniBox: Failed to fetch widget configuration:", error);
      return null;
    }
  }

  // --- 7. INITIALIZATION ---
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }

  async function init() {
    try {
      // Fetch configuration from API
      fetchedConfig = await fetchWidgetConfig();

      if (fetchedConfig === null) {
        removeWidgetRoot();
        return;
      }

      // Merge fetched config with defaults
      settings = deepMerge(defaults, fetchedConfig);

      // IMPORTANT: Runtime config from API is source of truth.
      // Do not overlay visual/behavior config from encrypted payload, so any
      // chatbot config updates are reflected immediately across all websites.

      // Now initialize API URLs and socket config with the baseUrl
      API_BASE = baseUrl;
      // Use utilityApiBaseUrl from config if provided, otherwise construct it
      // utilityApiBaseUrl should be like: https://dev-api.salesastra.ai/utilities/v1/s3
      if (fetchedConfig && fetchedConfig.utilityApiBaseUrl) {
        UTILITY_API_BASE = normalizeUtilityS3Base(
          fetchedConfig.utilityApiBaseUrl,
        );
        console.log(
          "UniBox: Using utility API URL from config:",
          UTILITY_API_BASE,
        );
      } else if (userConfig.utilityApiBaseUrl) {
        UTILITY_API_BASE = normalizeUtilityS3Base(userConfig.utilityApiBaseUrl);
        console.log(
          "UniBox: Using utility API URL from userConfig:",
          UTILITY_API_BASE,
        );
      } else {
        // Fallback: construct from API_BASE
        UTILITY_API_BASE = normalizeUtilityS3Base(getUtilityBaseUrl());
      }
      if (!UTILITY_API_BASE) {
        throw new Error(
          "Missing utility API base URL. Provide utilityApiBaseUrl or utilityServiceBase.",
        );
      }
      UTILITY_S3_URL = `${UTILITY_API_BASE}/generate-access-url`;

      SOCKET_CONFIG = getSocketConfig(API_BASE);
      WS_URL = getWebSocketUrl();

      const mobileConfig = getMobileExperienceConfig();
      if (mobileConfig.isMobile && !mobileConfig.mobileWidgetEnabled) {
        console.log("UniBox: Widget disabled for mobile view");
        removeWidgetRoot();
        return;
      }

      if (!shouldRenderByInstallationRules()) {
        console.log("UniBox: Widget hidden by installation rules");
        removeWidgetRoot();
        return;
      }

      if (!shouldRenderOnCurrentPath()) {
        console.log("UniBox: Widget hidden by advanced page rules");
        removeWidgetRoot();
        return;
      }

      loadGoogleFont(settings.appearance.fontFamily);

      resolvedHeaderLogoUrl = "";
      resolvedBrandLogoUrl = "";
      resolvedLauncherCustomUrl = "";
      const appear = settings.appearance || {};
      const previewSnap = settings.preview || {};

      const firstNonEmpty = (...values) => {
        for (const value of values) {
          const normalized = String(value || "").trim();
          if (normalized) return normalized;
        }
        return "";
      };

      // Keep header logo resolution independent from launcher type/icon selection.
      const headerLogoKey = firstNonEmpty(
        appear.headerLogoUrl,
        previewSnap.headerLogoUrl,
        appear.brandLogoUrl,
        previewSnap.brandLogoUrl,
        appear.logoUrl,
        previewSnap.logoUrl,
      );
      const brandLogoKey = firstNonEmpty(
        appear.brandLogoUrl,
        previewSnap.brandLogoUrl,
        appear.logoUrl,
        previewSnap.logoUrl,
      );

      // Header icon: prefer headerLogoUrl, then fallback to brand/logo.
      if (headerLogoKey) {
        try {
          resolvedHeaderLogoUrl = await fetchLogoUrl(headerLogoKey);
        } catch (err) {
          console.warn("UniBox: Failed to load header logo", err);
        }
      }

      if (brandLogoKey) {
        try {
          resolvedBrandLogoUrl = await fetchLogoUrl(brandLogoKey);
        } catch (err) {
          console.warn("UniBox: Failed to load brand logo", err);
        }
      }

      // Launcher icon: uses launcherIconUrl if provided, otherwise falls back to brandLogoUrl / logoUrl
      const launcherCustomKey = firstNonEmpty(
        previewSnap.launcherIconUrl,
        appear.launcherIconUrl,
      );
      if (launcherCustomKey) {
        try {
          resolvedLauncherCustomUrl = await fetchLogoUrl(launcherCustomKey);
        } catch (err) {
          console.warn("UniBox: Failed to load launcher custom icon", err);
        }
      } else if (brandLogoKey) {
        // No dedicated launcher icon — fall back to brand/logo URL
        resolvedLauncherCustomUrl =
          resolvedBrandLogoUrl || resolvedHeaderLogoUrl;
      }

      const previewForAvatar = settings.preview || {};
      if (previewForAvatar.chatAvatarUrl) {
        try {
          resolvedAvatarUrl = await fetchLogoUrl(
            String(previewForAvatar.chatAvatarUrl),
          );
        } catch (err) {
          console.warn("UniBox: Failed to load chat avatar", err);
        }
      } else {
        resolvedAvatarUrl = "";
      }

      renderWidget();

      if (settings.testMode) {
        console.warn("UniBox: Running in TEST MODE.");
      }

      // Widget uses native WebSocket — no Socket.IO dependency needed.
      if (userId) {
        const hasSubmittedForm =
          sessionStorage.getItem(SESSION_KEY_FORM) === "true";
        if (!settings.preChatForm.enabled || hasSubmittedForm) {
          restoreExistingConversation();
        }
      }
    } catch (error) {
      console.error("UniBox: Initialization failed:", error);
      removeWidgetRoot();
    }
  }

  // --- 8. S3 LOGIC ---

  /**
   * Fetch signed URL for logo/images (uses normal utility S3 endpoint)
   * @param {string} fileName - The S3 key or file name
   * @returns {Promise<string>} - The presigned URL
   */
  async function fetchLogoUrl(fileName) {
    if (!fileName || typeof fileName !== "string") return "";
    const trimmed = fileName.trim();
    if (/^(https?:|blob:|data:)/i.test(trimmed)) return trimmed;
    try {
      const res = await fetch(UTILITY_S3_URL, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ key: trimmed }),
      });
      if (!res.ok) throw new Error("S3 Sign failed");
      const data = await res.text();
      try {
        return JSON.parse(data).url || JSON.parse(data).signedUrl || data;
      } catch (e) {
        return data;
      }
    } catch (error) {
      return "";
    }
  }

  /**
   * Fetch signed URL for media files (uses utility service endpoint)
   * @param {string} key - The S3 key
   * @returns {Promise<string | null>} - The presigned URL or null if error
   */
  function parsePresignedExpiry(url) {
    if (!url || typeof url !== "string") return null;
    try {
      const parsed = new URL(url);
      const amzDateRaw = parsed.searchParams.get("X-Amz-Date");
      const amzExpiresRaw = parsed.searchParams.get("X-Amz-Expires");
      if (!amzDateRaw || !amzExpiresRaw) return null;
      const d = String(amzDateRaw);
      if (d.length < 15) return null;
      const year = Number(d.slice(0, 4));
      const month = Number(d.slice(4, 6)) - 1;
      const day = Number(d.slice(6, 8));
      const hour = Number(d.slice(9, 11));
      const minute = Number(d.slice(11, 13));
      const second = Number(d.slice(13, 15));
      const startTs = Date.UTC(year, month, day, hour, minute, second);
      const ttlSeconds = Number(amzExpiresRaw);
      if (!Number.isFinite(startTs) || !Number.isFinite(ttlSeconds)) return null;
      return startTs + ttlSeconds * 1000;
    } catch (e) {
      return null;
    }
  }

  function isCachedMediaUrlUsable(cached) {
    if (!cached || !cached.url) return false;
    // If expiry is unknown, allow a short-lived cache window.
    if (!cached.expiresAt) return true;
    // Refresh 2 minutes before expiry to avoid edge failures.
    return Date.now() < cached.expiresAt - 2 * 60 * 1000;
  }

  async function fetchMediaUrl(key, options) {
    if (!key) return null;
    const forceRefresh = Boolean(options && options.forceRefresh);

    // If a full URL is passed, return it as-is
    if (key.startsWith("http://") || key.startsWith("https://")) {
      return key;
    }

    const cacheKey = String(key);
    if (!forceRefresh) {
      const cached = mediaUrlCache.get(cacheKey);
      if (isCachedMediaUrlUsable(cached)) {
        return cached.url;
      }
    }

    try {
      const res = await fetch(UTILITY_S3_URL, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ key: key }),
      });

      if (!res.ok) {
        throw new Error("Failed to get media URL");
      }

      const data = await res.text();

      // Response is plain text (the presigned URL)
      const url = typeof data === "string" ? data : String(data);

      // Validate that the response is a valid URL
      if (!url.startsWith("http")) {
        throw new Error("Invalid URL format returned from server");
      }

      mediaUrlCache.set(cacheKey, {
        url,
        expiresAt: parsePresignedExpiry(url),
      });
      return url;
    } catch (error) {
      console.error("UniBox: Error getting media access URL:", error);
      return null;
    }
  }

  // Legacy function for backward compatibility
  async function fetchSignedUrl(fileName) {
    return fetchLogoUrl(fileName);
  }

  // --- 9. API & SOCKET LOGIC ---

  async function restoreExistingConversation() {
    if (conversationId || !userId) return;
    setLoading(true);
    try {
      const restoreRes = await fetch(`${API_BASE}/thread/${userId}?limit=50`, {
        method: "GET",
        headers: getHeaders(),
      });

      if (restoreRes.ok) {
        const data = await restoreRes.json();
        if (data.conversation) {
          conversationId = data.conversation.id;
          maybeApplyVirtualAgentFromConversation(data.conversation);
          setLoading(false);

          if (data.messages && Array.isArray(data.messages)) {
            const replayActivePopupFormMessageId =
              getReplayActivePopupFormMessageId(data.messages);
            const replayActiveChoiceMessageId =
              getReplayActiveChoiceMessageId(data.messages);
            if (staticWelcomeShown) {
              const staticWelcome = Array.from(messages.values()).find(
                (msg) => msg.id && msg.id.startsWith("static_welcome_"),
              );
              if (staticWelcome && staticWelcome.element) {
                staticWelcome.element.remove();
                messages.delete(staticWelcome.id);
              }
              staticWelcomeShown = false;
            }

            data.messages.forEach((msg) => {
              // Normalize text - convert empty string to null
              const textValue = msg.text || msg.text_body;
              const normalizedTextValue =
                textValue && textValue.trim() ? textValue.trim() : null;

              const canonicalTimestamp =
                // Prefer canonical millisecond timestamp if present
                (typeof msg.timestamp === "number" && msg.timestamp) ||
                // Then prefer ISO timestamp string if available
                (msg.timestamp_iso
                  ? msg.timestamp_iso
                  : // Fallback: derive from legacy seconds-based field
                    typeof msg.timestamp_meta === "number"
                    ? msg.timestamp_meta * 1000
                    : undefined);

              appendMessageToUI(
                normalizedTextValue,
                msg.sender || (msg.direction === "inbound" ? "user" : "agent"),
                msg.id || msg.messageId,
                canonicalTimestamp,
                msg.status,
                msg.readAt,
                msg.readByUs,
                msg.readByUsAt,
                msg.type,
                msg.media_storage_url,
                extractFlowPayload(msg),
                msg.agentName ?? msg.agent_name ?? null,
                msg.is_ai_reply === true || msg.isAiReply === true,
                (msg.id || msg.messageId) === replayActivePopupFormMessageId,
                (msg.id || msg.messageId) === replayActiveChoiceMessageId,
              );
            });
            setTimeout(() => {
              sortMessagesByTimestamp();
              markVisibleMessagesAsRead();
            }, 500);
          }
          // Connect to WebSocket AND subscribe to conversation for real-time updates
          connectSocket().then(() => {
            // Subscribe after connection is established
            subscribeToConversation(conversationId);
          });
        } else {
          setLoading(false);
        }
      } else {
        setLoading(false);
      }
    } catch (e) {
      setLoading(false);
    }
  }

  async function initializeConversation(showLoading = false) {
    if (conversationId) return;

    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }

    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.name = storedName;
      if (storedEmail) userDetails.email = storedEmail;
    }

    if (showLoading) {
      setLoading(true);
    }

    try {
      if (!settings.testMode) {
        try {
          const restoreRes = await fetch(
            `${API_BASE}/thread/${userId}?limit=50`,
            {
              method: "GET",
              headers: getHeaders(),
            },
          );
          if (restoreRes.ok) {
            const data = await restoreRes.json();
            if (data.conversation) {
              maybeApplyVirtualAgentFromConversation(data.conversation);
              const latestStatus = data.conversation.status || "active";
              const isEndedSession = latestStatus !== "active";

              // Remove static welcome message before loading real messages
              if (staticWelcomeShown) {
                const staticWelcome = Array.from(messages.values()).find(
                  (msg) => msg.id && msg.id.startsWith("static_welcome_"),
                );
                if (staticWelcome && staticWelcome.element) {
                  staticWelcome.element.remove();
                  messages.delete(staticWelcome.id);
                }
                staticWelcomeShown = false;
              }

              // Render historical messages for this user (even if the last session is ended)
              if (data.messages && Array.isArray(data.messages)) {
                const replayActivePopupFormMessageId =
                  getReplayActivePopupFormMessageId(data.messages);
                const replayActiveChoiceMessageId =
                  getReplayActiveChoiceMessageId(data.messages);
                data.messages.forEach((msg) => {
                  // Normalize text - convert empty string to null
                  const textValue = msg.text || msg.text_body;
                  const normalizedTextValue =
                    textValue && textValue.trim() ? textValue.trim() : null;

                  const canonicalTimestamp =
                    (typeof msg.timestamp === "number" && msg.timestamp) ||
                    (msg.timestamp_iso
                      ? msg.timestamp_iso
                      : typeof msg.timestamp_meta === "number"
                        ? msg.timestamp_meta * 1000
                        : undefined);

                  appendMessageToUI(
                    normalizedTextValue,
                    msg.sender ||
                      (msg.direction === "inbound" ? "user" : "agent"),
                    msg.id || msg.messageId,
                    canonicalTimestamp,
                    msg.status,
                    msg.readAt,
                    msg.readByUs,
                    msg.readByUsAt,
                    msg.type,
                    msg.media_storage_url,
                    extractFlowPayload(msg),
                    msg.agentName ?? msg.agent_name ?? null,
                    msg.is_ai_reply === true || msg.isAiReply === true,
                    (msg.id || msg.messageId) === replayActivePopupFormMessageId,
                    (msg.id || msg.messageId) === replayActiveChoiceMessageId,
                  );
                });
                const hasInboundBotMessage = data.messages.some((msg) => {
                  const sender =
                    msg.sender || (msg.direction === "inbound" ? "user" : "agent");
                  return isRealInboundBotMessage(sender, msg.id || msg.messageId);
                });
                if (hasInboundBotMessage) {
                  waitingForFirstInboundMessage = false;
                }
                markVisibleMessagesAsRead();
              }

              if (isEndedSession) {
                // Last session is already resolved/expired – rotate guest id so that
                // the next outbound message starts a completely new session/contact.
                if (typeof userId === "string" && userId.startsWith("guest_")) {
                  userId = `guest_${Date.now()}_${Math.random()
                    .toString(36)
                    .substr(2, 9)}`;
                  try {
                    localStorage.setItem(STORAGE_KEY_USER, userId);
                  } catch (e) {
                    console.warn(
                      "UniBox: Failed to persist rotated guest id after restore",
                      e,
                    );
                  }
                }

                // Do NOT reuse old conversationId – leave it null so that the next
                // sendMessageToApi()/sendSelectedFiles() call creates a fresh session.
                conversationId = null;
                clearLiveAgentDisplayName();

                if (showLoading) {
                  setLoading(false);
                }
                return;
              }

              conversationId = data.conversation.id;
              if (showLoading) {
                setLoading(false);
              }
              // Never overlay the full-body spinner while waiting for bot text —
              // use the in-thread typing indicator (optimistic or server-driven) instead.
              setInitialBodyLoading(false);

              // Connect to WebSocket AND subscribe for real-time updates
              connectSocket().then(() => {
                subscribeToConversation(conversationId);
              });
              return;
            }
          }
        } catch (e) {}
      }

      const res = await fetch(`${API_BASE}/conversation`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          userId: userId,
          userName: userDetails.name || "Guest User",
          userEmail: userDetails.email || "",
          testMode: settings.testMode,
          // Required so the backend stores chatbotId in conversation.metadata
          // and can resolve the published workflow for this chatbot.
          chatbotId: userConfig.chatbotId || undefined,
        }),
      });

      if (!res.ok) throw new Error("Failed to start conversation");
      const data = await res.json();
      clearLiveAgentDisplayName();
      conversationId = data.conversationId;
      console.log("UniBox: Conversation created:", conversationId);

      // Connect to WebSocket and subscribe
      skipThreadFetchOnNextSocketConnect = true;
      await connectSocket();
      subscribeToConversation(conversationId);

      // Don't fetch thread here - it will be fetched by fetchAndRenderThreadAfterSend
      if (showLoading) {
        setLoading(false);
      }
      // Do NOT force the initial body loader here. Conversation creation is
      // triggered AFTER the user has already sent their first message — at
      // this point the chat body has the static welcome + the outbound user
      // bubble already rendered, and the bot's reply will surface via the
      // normal typing indicator flow. Forcing the full-body spinner on top
      // of real content creates the "loading in between" artefact.
      waitingForFirstInboundMessage = false;
      setInitialBodyLoading(false);
    } catch (error) {
      console.error("UniBox: Init Error", error);
      if (showLoading) {
        setLoading(false);
      }
    }
  }

  /**
   * Get JWT token for WebSocket authentication
   */
  async function getWebSocketToken() {
    try {
      const res = await fetch(`${API_BASE}/websocket/token`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          userId: userId,
          conversationId: conversationId,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to get WebSocket token");
      }

      const data = await res.json();
      return data.token;
    } catch (error) {
      console.error("UniBox: Failed to get WebSocket token", error);
      return null;
    }
  }

  /**
   * Connect to WebSocket service (replaces Socket.IO)
   * @returns {Promise<boolean>} - Resolves to true when connected, false on failure
   */
  async function connectSocket() {
    // Already connected
    if (socket && socket.readyState === WebSocket.OPEN) {
      console.log("UniBox: WebSocket already connected");
      return true;
    }

    // Connection already in progress - wait for it
    if (isConnecting && wsConnectPromise) {
      console.log("UniBox: Connection already in progress, waiting...");
      return wsConnectPromise;
    }

    // Socket is connecting - wait for it
    if (
      socket &&
      socket.readyState === WebSocket.CONNECTING &&
      wsConnectPromise
    ) {
      console.log("UniBox: WebSocket is still connecting, waiting...");
      return wsConnectPromise;
    }

    // Clean up any stale socket
    if (
      socket &&
      (socket.readyState === WebSocket.CLOSING ||
        socket.readyState === WebSocket.CLOSED)
    ) {
      socket = null;
    }

    if (!conversationId || !WS_URL) {
      console.log("UniBox: Missing conversationId or WS_URL for WebSocket");
      return false;
    }

    // Set connecting flag BEFORE async operations
    isConnecting = true;

    // Get JWT token for WebSocket authentication
    if (!wsToken) {
      wsToken = await getWebSocketToken();
      if (!wsToken) {
        console.error("UniBox: Cannot connect to WebSocket without token");
        isConnecting = false;
        return false;
      }
    }

    // Create connection promise that will be resolved in onopen/onerror
    wsConnectPromise = new Promise((resolve) => {
      wsConnectResolve = resolve;
    });

    try {
      // Connect to WebSocket with JWT token
      const wsUrl = `${WS_URL}?token=${wsToken}`;
      console.log(
        "UniBox: Creating new WebSocket connection to:",
        wsUrl.split("?")[0],
      );

      // Create the WebSocket
      const ws = new WebSocket(wsUrl);
      socket = ws;

      ws.onopen = () => {
        console.log(
          "UniBox: WebSocket onopen fired, readyState:",
          ws.readyState,
        );

        // Reset connecting flag
        isConnecting = false;

        // Verify connection is actually open
        if (ws.readyState !== WebSocket.OPEN) {
          console.error(
            "UniBox: onopen fired but readyState is not OPEN:",
            ws.readyState,
          );
          if (wsConnectResolve) {
            wsConnectResolve(false);
            wsConnectResolve = null;
          }
          return;
        }

        console.log("UniBox: WebSocket successfully connected");
        refreshHeaderPresence();

        // Resolve the connection promise IMMEDIATELY
        if (wsConnectResolve) {
          wsConnectResolve(true);
          wsConnectResolve = null;
        }

        // Subscribe to conversation if we have a valid conversationId
        if (!subscribeToConversation(conversationId)) {
          console.log(
            "UniBox: Will subscribe later when conversation is created",
          );
        }

        // Flush any pending messages
        flushPendingMessages();

        const shouldFetchThreadHistory = !skipThreadFetchOnNextSocketConnect;
        skipThreadFetchOnNextSocketConnect = false;

        // Fetch message history after connection (delayed to avoid blocking)
        if (shouldFetchThreadHistory) {
          setTimeout(() => {
            if (userId && conversationId) {
              fetch(`${API_BASE}/thread/${userId}?limit=50`, {
                method: "GET",
                headers: getHeaders(),
              })
                .then((res) => (res.ok ? res.json() : null))
                .then((threadData) => {
                  if (
                    threadData &&
                    threadData.messages &&
                    Array.isArray(threadData.messages)
                  ) {
                    const replayActivePopupFormMessageId =
                      getReplayActivePopupFormMessageId(threadData.messages);
                    const replayActiveChoiceMessageId =
                      getReplayActiveChoiceMessageId(threadData.messages);
                    threadData.messages.forEach((msg) => {
                      // Normalize text - convert empty string to null
                      const textValue = msg.text || msg.text_body;
                      const normalizedTextValue =
                        textValue && textValue.trim() ? textValue.trim() : null;

                      const canonicalTimestamp =
                        (typeof msg.timestamp === "number" && msg.timestamp) ||
                        (msg.timestamp_iso
                          ? msg.timestamp_iso
                          : typeof msg.timestamp_meta === "number"
                            ? msg.timestamp_meta * 1000
                            : undefined);

                      appendMessageToUI(
                        normalizedTextValue,
                        msg.sender ||
                          (msg.direction === "inbound" ? "user" : "agent"),
                        msg.id || msg.messageId,
                        canonicalTimestamp,
                        msg.status,
                        msg.readAt,
                        msg.readByUs,
                        msg.readByUsAt,
                        msg.type,
                        msg.media_storage_url,
                        extractFlowPayload(msg),
                        msg.agentName ?? msg.agent_name ?? null,
                        msg.is_ai_reply === true || msg.isAiReply === true,
                        (msg.id || msg.messageId) === replayActivePopupFormMessageId,
                        (msg.id || msg.messageId) === replayActiveChoiceMessageId,
                      );
                    });
                    sortMessagesByTimestamp();
                    setTimeout(() => {
                      markVisibleMessagesAsRead();
                    }, 500);
                  }
                })
                .catch((e) =>
                  console.error(
                    "UniBox: Failed to fetch thread after socket connect",
                    e,
                  ),
                );
            }
          }, 500);
        }
      };

      // Handle incoming WebSocket messages
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          handleWebSocketMessage(message);
        } catch (error) {
          console.error("UniBox: Failed to parse WebSocket message", error);
        }
      };

      ws.onerror = (error) => {
        console.error("UniBox: WebSocket error", error);
        isConnecting = false;
        // Resolve connection promise as failed
        if (wsConnectResolve) {
          wsConnectResolve(false);
          wsConnectResolve = null;
        }
      };

      ws.onclose = () => {
        console.log("UniBox: WebSocket disconnected");
        isConnecting = false;

        // Resolve connection promise as failed if still pending
        if (wsConnectResolve) {
          wsConnectResolve(false);
          wsConnectResolve = null;
        }

        // Only clean up if this is still the active socket
        if (socket === ws) {
          // Capture conversationId NOW before any delayed session_status_change
          // event can clear the module-level variable, which would otherwise
          // silently prevent the reconnect attempt below.
          const convIdAtDisconnect = conversationId;

          socket = null;
          wsToken = null;
          wsConnectPromise = null;
          subscribedConversationId = null; // Reset subscription state on disconnect
          refreshHeaderPresence();

          // Attempt to reconnect after 3 seconds.
          // Use convIdAtDisconnect so a race with session_status_change cannot
          // suppress the reconnect. After connecting, re-read conversationId in
          // case it was updated (new session) during the 3-second window.
          setTimeout(() => {
            const targetConvId = conversationId || convIdAtDisconnect;
            if (targetConvId) {
              connectSocket().then(() => {
                subscribeToConversation(conversationId || convIdAtDisconnect);
              });
            }
          }, 3000);
        }
      };

      // Return the connection promise so callers can await it
      return wsConnectPromise;
    } catch (error) {
      console.error("UniBox: Failed to connect WebSocket", error);
      isConnecting = false;
      socket = null;
      wsToken = null;
      if (wsConnectResolve) {
        wsConnectResolve(false);
        wsConnectResolve = null;
      }
      return false;
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  function handleWebSocketMessage(message) {
    let type = message.type ?? message.event ?? message.Event;
    let data = message.data;
    if (data === undefined && message.payload !== undefined) {
      data = message.payload;
    }
    if (
      !type &&
      typeof message.action === "string" &&
      /^(agent_assigned|handoff|live_agent_connected|virtual_agent_assigned|agent_joined)$/i.test(
        message.action,
      )
    ) {
      type = message.action;
    }
    if (!type && typeof message.action === "string") {
      const a = message.action.toLowerCase();
      if (a === "presence" || a === "presence_update") {
        type = message.action;
      } else if (a === "typing") {
        type = "typing";
      }
    }

    const normalizedType =
      type != null ? String(type).toLowerCase().replace(/\./g, "_") : "";

    // Debug logging for all incoming messages
    console.log("UniBox: WebSocket message received:", {
      type,
      normalizedType,
      hasData: !!data,
    });

    switch (normalizedType) {
      case "message_created":
      case "message":
        console.log("UniBox: Processing MESSAGE_CREATED:", data || message);
        {
          const evt = data || message;
          // Compatibility fallback: some backends/fan-out paths don't emit a
          // dedicated assignment event, but agent messages already contain
          // agent_id/agent_name. Promote that into the assignment handshake so
          // header + labels switch from Pulse AI to the live agent reliably.
          const evtAgentName = extractVirtualAgentDisplayName(evt);
          const evtAgentId = extractVirtualAgentId(evt);
          const evtIsAiReply =
            evt?.is_ai_reply === true || evt?.isAiReply === true;
          const evtSender = String(evt?.sender ?? "").toLowerCase();
          if ((evtAgentName || evtAgentId) && !evtIsAiReply && evtSender === "agent") {
            handleAgentAssignmentHandshake(evt, message);
          }
          // Some backends piggyback typing stop on message envelopes.
          // Apply stop immediately, then continue processing the message payload.
          if (evt && (evt.isTyping === false || evt.typing === false)) {
            handleTypingIndicator({
              ...evt,
              isAgent:
                evt.isAgent === true ||
                evt.sender === "agent" ||
                evt.role === "agent",
              isAi:
                evt.isAi === true ||
                evt.sender === "ai" ||
                evt.is_ai_reply === true,
              from:
                evt.from ||
                (evt.sender === "agent"
                  ? "agent"
                  : evt.sender === "ai" || evt.is_ai_reply === true
                    ? "ai"
                    : undefined),
            });
          }
          if (evt.messageId || evt.text || evt.sender) {
            handleIncomingMessage(evt);
          }
        }
        break;

      case "typing":
        handleTypingIndicator(data || message);
        break;

      case "read":
        // User does NOT receive read receipts from agent
        // This is intentionally ignored per design
        break;

      case "media_upload_response":
        // Handled by requestPresignedUrl via addEventListener
        // No action needed here, just prevent logging unknown type
        break;

      case "agent_assigned":
      case "handoff":
      case "live_agent_connected":
      case "virtual_agent_assigned":
      case "agent_joined":
      case "conversation_agent_assigned":
      case "live_chat_agent_assigned": {
        const evt = data || message;
        // Human takeover: suppress optimistic AI dots and interpret typing events
        // as agent-side. Skip virtual_agent_assigned — often an AI persona, not a human.
        if (normalizedType !== "virtual_agent_assigned") {
          humanLiveAgentHandoff = true;
        }
        handleAgentAssignmentHandshake(evt, message);
        break;
      }

      case "session_status_change": {
        const evt = data || message;
        try {
          // Only handle live_chat session lifecycle events for this widget.
          const platform = evt && (evt.platform || evt.channel || "live_chat");
          const status = evt && evt.status;
          const endedStatus =
            status && (status === "resolved" || status === "expired");

          if (platform === "live_chat" && endedStatus) {
            // If this event is for the current conversation, clear it so the
            // next user message starts a fresh session.
            if (evt.conversationId && conversationId === evt.conversationId) {
              conversationId = null;
              subscribedConversationId = null;
              workflowAutoStarted = false; // Allow workflow to re-boot on next open
              clearLiveAgentDisplayName();
            }

            // Rotate guest id so that a new live_chat contact/session is created
            // on the next message, instead of reusing the old userId.
            if (typeof userId === "string" && userId.startsWith("guest_")) {
              userId = `guest_${Date.now()}_${Math.random()
                .toString(36)
                .substr(2, 9)}`;
              try {
                localStorage.setItem(STORAGE_KEY_USER, userId);
              } catch (e) {
                console.warn(
                  "UniBox: Failed to persist rotated guest id to localStorage",
                  e,
                );
              }
            }
          }
        } catch (e) {
          console.error(
            "UniBox: Failed to handle session_status_change event",
            e,
          );
        }
        break;
      }

      case "presence":
      case "presence_update":
      case "peer_presence": {
        const evt = data || message;
        const conv =
          evt.conversationId ?? evt.conversation_id ?? message.conversationId;
        if (
          conv != null &&
          conversationId != null &&
          String(conv) !== String(conversationId)
        ) {
          break;
        }

        if (evt.isTyping === false || evt.typing === false) {
          // Clear the typing indicator — a presence event with isTyping:false means
          // the peer stopped typing. Route through the shared handler so all cleanup
          // (optimistic timer, agentTypingTimeout, showTypingIndicator) is applied.
          handleTypingIndicator(evt);
          break;
        }

        const explicitPeer =
          evt.peerOnline ?? evt.agentOnline ?? evt.agent_online;
        if (typeof explicitPeer === "boolean") {
          if (liveAgentDisplayName) {
            isAgentOnline = explicitPeer;
            refreshHeaderPresence();
          }
          break;
        }

        const uid = evt.userId ?? evt.user_id;
        if (uid != null && userId != null && String(uid) === String(userId)) {
          refreshHeaderPresence();
          break;
        }

        if (
          evt.isAgent === true ||
          evt.role === "agent" ||
          evt.principalType === "agent" ||
          evt.participant === "agent"
        ) {
          const offline =
            evt.status === "offline" ||
            evt.isOnline === false ||
            evt.online === false;
          isAgentOnline = !offline;
          refreshHeaderPresence();
        }
        break;
      }

      case "subscribed":
        console.log("UniBox: Subscribed to conversation", data || message);
        break;

      case "error":
        console.error("UniBox: WebSocket error:", data || message);
        break;

      default:
        // Handle legacy format or unknown types
        if (message.messageId || message.text || message.sender) {
          handleIncomingMessage(message);
        } else {
          console.log(
            "UniBox: Unknown WebSocket message type:",
            normalizedType || type,
            message,
          );
        }
    }
  }

  /**
   * Handle incoming message from WebSocket
   */
  function toTimestampMs(value) {
    if (value == null) return null;

    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }

    if (typeof value === "string") {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric < 1e12 ? numeric * 1000 : numeric;
      }
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }

    return null;
  }

  function getCanonicalMessageTimestamp(message) {
    return (
      toTimestampMs(message?.timestamp) ??
      toTimestampMs(message?.timestamp_iso) ??
      toTimestampMs(message?.timestamp_meta) ??
      toTimestampMs(message?.createdAt) ??
      toTimestampMs(message?.created_at) ??
      toTimestampMs(message?.sentAt) ??
      toTimestampMs(message?.sent_at)
    );
  }

  function normalizeSocketMessagePayload(message) {
    if (!message || typeof message !== "object") return message;
    const nested = message.message && typeof message.message === "object" ? message.message : null;
    const source = nested || message;
    const payload =
      source.payload && typeof source.payload === "object" ? source.payload : {};

    const normalized = Object.assign({}, source);

    normalized.messageId =
      source.messageId ??
      source.message_id ??
      source.id ??
      message.messageId ??
      message.message_id ??
      message.id;

    normalized.conversationId =
      source.conversationId ??
      source.conversation_id ??
      message.conversationId ??
      message.conversation_id;

    const senderRaw =
      source.sender ??
      (source.direction === "inbound" ? "user" : null) ??
      (source.direction === "outbound" ? "agent" : null) ??
      (String(source.direction || "").toUpperCase() === "INBOUND" ? "user" : null) ??
      (String(source.direction || "").toUpperCase() === "OUTBOUND" ? "agent" : null) ??
      (source.role === "agent" ? "agent" : null) ??
      (source.role === "user" ? "user" : null) ??
      message.sender;
    normalized.sender =
      typeof senderRaw === "string"
        ? senderRaw.toLowerCase() === "agent" || senderRaw.toUpperCase() === "AGENT"
          ? "agent"
          : senderRaw.toLowerCase() === "user" || senderRaw.toUpperCase() === "USER"
            ? "user"
            : senderRaw
        : senderRaw;

    normalized.text =
      source.text ??
      source.textBody ??
      source.text_body ??
      payload.text ??
      payload.body ??
      message.text;

    normalized.type =
      typeof (source.type ?? payload.type ?? message.type) === "string"
        ? String(source.type ?? payload.type ?? message.type).toLowerCase()
        : source.type ?? payload.type ?? message.type;
    normalized.media_storage_url =
      source.media_storage_url ??
      source.mediaStorageUrl ??
      message.media_storage_url ??
      message.mediaStorageUrl ??
      null;
    normalized.status = source.status ?? message.status;

    normalized.agent_id =
      source.agent_id ??
      source.agentId ??
      payload.agent_id ??
      payload.agentId ??
      (source.agent && (source.agent.id ?? source.agent.agentId)) ??
      (payload.agent && (payload.agent.id ?? payload.agent.agentId)) ??
      message.agent_id ??
      message.agentId;

    normalized.agent_name =
      source.agent_name ??
      source.agentName ??
      payload.agent_name ??
      payload.agentName ??
      (source.agent && (source.agent.name ?? source.agent.agentName)) ??
      (payload.agent && (payload.agent.name ?? payload.agent.agentName)) ??
      message.agent_name ??
      message.agentName;

    normalized.agent_profile_key =
      source.agent_profile_key ??
      source.agentProfileKey ??
      payload.agent_profile_key ??
      payload.agentProfileKey ??
      (source.agent &&
        (source.agent.profile_key ??
          source.agent.profileKey ??
          source.agent.avatar_key ??
          source.agent.avatarKey)) ??
      (payload.agent &&
        (payload.agent.profile_key ??
          payload.agent.profileKey ??
          payload.agent.avatar_key ??
          payload.agent.avatarKey)) ??
      message.agent_profile_key ??
      message.agentProfileKey;

    normalized.agent_profile_url =
      source.agent_profile_url ??
      source.agentProfileUrl ??
      payload.agent_profile_url ??
      payload.agentProfileUrl ??
      (source.agent &&
        (source.agent.profile_url ??
          source.agent.profileUrl ??
          source.agent.avatar_url ??
          source.agent.avatarUrl)) ??
      (payload.agent &&
        (payload.agent.profile_url ??
          payload.agent.profileUrl ??
          payload.agent.avatar_url ??
          payload.agent.avatarUrl)) ??
      message.agent_profile_url ??
      message.agentProfileUrl ??
      null;

    normalized.agent_avatar_url =
      source.agent_avatar_url ??
      source.agentAvatarUrl ??
      payload.agent_avatar_url ??
      payload.agentAvatarUrl ??
      message.agent_avatar_url ??
      message.agentAvatarUrl ??
      null;

    normalized.agent = source.agent ?? payload.agent ?? message.agent;
    normalized.is_ai_reply =
      source.is_ai_reply === true ||
      source.isAiReply === true ||
      payload.is_ai_reply === true ||
      payload.isAiReply === true ||
      message.is_ai_reply === true ||
      message.isAiReply === true;

    normalized.timestamp =
      source.timestamp ??
      source.createdAt ??
      source.created_at ??
      source.sentAt ??
      source.sent_at ??
      message.timestamp;

    normalized.flow = extractFlowPayload(source) || extractFlowPayload(message);

    return normalized;
  }

  function normalizeFlowPayload(candidate) {
    if (!candidate || typeof candidate !== "object") return null;

    // ── Already-normalized object OR Kinesis/Lambda enriched format ─────────
    // The backend now emits a single "Kinesis-compatible" shape that carries
    // BOTH the legacy Lambda-readable field (`nodeType`) and all rich fields
    // (`nodeId`, `type`, `inputType`, `dropdownOptions`, …).
    //
    // Detect this shape by: nodeType is a non-empty string AND at least one of
    // the enriched fields is present (including `type`, which the old botFlow
    // format never set alongside `nodeType`).
    if (
      typeof candidate.nodeType === "string" &&
      candidate.nodeType.length > 0 &&
      (candidate.nodeId !== undefined ||
        candidate.type !== undefined ||
        candidate.inputType !== undefined ||
        candidate.isEnd !== undefined ||
        candidate.dropdownOptions !== undefined ||
        candidate.typingDelayMs !== undefined ||
        candidate.emojiSupport !== undefined ||
        candidate.form !== undefined)
    ) {
      // Options in this shape already use the old {id, title, next_node_id}
      // keys (set by toKinesisFlowFormat on the backend).  Normalise them into
      // the internal {id, title, nextNodeId, value} form used by renderOptions.
      const rawOpts = Array.isArray(candidate.options) ? candidate.options : [];
      const options = rawOpts
        .map((opt) => {
          if (!opt || typeof opt !== "object") return null;
          const title =
            typeof opt.title === "string"
              ? opt.title.trim()
              : typeof opt.label === "string"
                ? opt.label.trim()
                : "";
          const id =
            typeof opt.id === "string"
              ? opt.id.trim()
              : typeof opt.value === "string"
                ? opt.value.trim()
                : title;
          if (!id && !title) return null;
          const nextNodeId =
            typeof opt.nextNodeId === "string"
              ? opt.nextNodeId.trim()
              : typeof opt.next_node_id === "string"
                ? opt.next_node_id.trim()
                : id;
          return { id, title: title || id, nextNodeId, value: id };
        })
        .filter(Boolean);
      return {
        nodeType: candidate.nodeType,
        nodeId: candidate.nodeId ?? null,
        inputType: candidate.inputType ?? null,
        dropdownOptions: Array.isArray(candidate.dropdownOptions)
          ? candidate.dropdownOptions.map(String).filter(Boolean)
          : null,
        form:
          candidate.form && typeof candidate.form === "object"
            ? candidate.form
            : null,
        isEnd: Boolean(candidate.isEnd),
        emojiSupport:
          typeof candidate.emojiSupport === "boolean"
            ? candidate.emojiSupport
            : null,
        typingDelayMs: candidate.typingDelayMs
          ? Number(candidate.typingDelayMs)
          : null,
        options,
      };
    }

    // ── New workflow engine format ──────────────────────────────────────────
    // Shape: { nodeId, type, options:[{label,value}], inputType, dropdownOptions,
    //          isEnd, typingDelayMs }
    const isWorkflowShape =
      typeof candidate.type === "string" &&
      candidate.type.length > 0 &&
      (candidate.nodeId !== undefined ||
        candidate.inputType !== undefined ||
        candidate.isEnd !== undefined ||
        (Array.isArray(candidate.options) &&
          candidate.options.length > 0 &&
          candidate.options[0] &&
          (candidate.options[0].label !== undefined ||
            candidate.options[0].value !== undefined)));

    if (isWorkflowShape) {
      const rawOpts = Array.isArray(candidate.options) ? candidate.options : [];
      const options = rawOpts
        .map((opt) => {
          if (!opt || typeof opt !== "object") return null;
          const label =
            typeof opt.label === "string"
              ? opt.label.trim()
              : typeof opt.title === "string"
                ? opt.title.trim()
                : "";
          const value =
            typeof opt.value === "string"
              ? opt.value.trim()
              : typeof opt.id === "string"
                ? opt.id.trim()
                : label;
          if (!label && !value) return null;
          return { id: value, title: label || value, value, nextNodeId: "" };
        })
        .filter(Boolean);

      return {
        nodeType: candidate.type,
        nodeId:
          typeof candidate.nodeId === "string" ? candidate.nodeId : null,
        inputType:
          typeof candidate.inputType === "string"
            ? candidate.inputType
            : null,
        dropdownOptions:
          Array.isArray(candidate.dropdownOptions)
            ? candidate.dropdownOptions.map(String).filter(Boolean)
            : null,
        form:
          candidate.form && typeof candidate.form === "object"
            ? candidate.form
            : null,
        isEnd: Boolean(candidate.isEnd),
        emojiSupport:
          typeof candidate.emojiSupport === "boolean"
            ? candidate.emojiSupport
            : null,
        typingDelayMs: candidate.typingDelayMs
          ? Number(candidate.typingDelayMs)
          : null,
        options,
      };
    }

    // ── Legacy / Kinesis-normalised botFlow format ──────────────────────────
    // Shape: { nodeType, options:[{id, title, next_node_id}] }
    // The Kinesis → Lambda pipeline re-emits the flow using these legacy field
    // names regardless of what enriched extra fields the backend included.
    // We therefore also accept nodeType-only objects (no options) so that
    // question / form / end nodes are not silently dropped.
    const nodeType =
      typeof candidate.nodeType === "string"
        ? candidate.nodeType
        : typeof candidate.node_type === "string"
          ? candidate.node_type
          : null;

    // Gather any enriched fields that the Lambda may have passed through.
    const enrichedNodeId =
      typeof candidate.nodeId === "string" ? candidate.nodeId : null;
    const enrichedInputType =
      typeof candidate.inputType === "string" ? candidate.inputType : null;
    const enrichedDropdownOptions = Array.isArray(candidate.dropdownOptions)
      ? candidate.dropdownOptions.map(String).filter(Boolean)
      : null;
    const enrichedForm =
      candidate.form && typeof candidate.form === "object"
        ? candidate.form
        : null;
    const enrichedIsEnd = Boolean(candidate.isEnd);
    const enrichedTypingDelayMs = candidate.typingDelayMs
      ? Number(candidate.typingDelayMs)
      : null;
    const enrichedEmojiSupport =
      typeof candidate.emojiSupport === "boolean"
        ? candidate.emojiSupport
        : null;

    const rawOptions = Array.isArray(candidate.options) ? candidate.options : [];
    const options = rawOptions
      .map((opt) => {
        if (!opt || typeof opt !== "object") return null;
        const id = typeof opt.id === "string" ? opt.id.trim() : "";
        const title = typeof opt.title === "string" ? opt.title.trim() : "";
        const nextNodeId =
          typeof opt.nextNodeId === "string"
            ? opt.nextNodeId.trim()
            : typeof opt.next_node_id === "string"
              ? opt.next_node_id.trim()
              : "";
        if (!id && !title) return null;
        return { id, title, nextNodeId, value: id };
      })
      .filter(Boolean);

    // Return null only when there is truly nothing useful (no nodeType and no
    // valid options).  A nodeType alone is enough to carry flow metadata for
    // non-options node types (question, form, end, handoff).
    if (!nodeType && !options.length) return null;

    return {
      nodeType,
      nodeId: enrichedNodeId,
      inputType: enrichedInputType,
      dropdownOptions: enrichedDropdownOptions,
      form: enrichedForm,
      isEnd: enrichedIsEnd,
      emojiSupport: enrichedEmojiSupport,
      typingDelayMs: enrichedTypingDelayMs,
      options,
    };
  }

  function resolveStartFlowFromBotFlow(botFlow) {
    if (!botFlow || typeof botFlow !== "object") return null;
    const startNodeId =
      typeof botFlow.startNodeId === "string" ? botFlow.startNodeId.trim() : "";
    const nodes = Array.isArray(botFlow.nodes) ? botFlow.nodes : [];
    if (!startNodeId || nodes.length === 0) return null;

    const startNode = nodes.find(
      (node) =>
        node &&
        typeof node === "object" &&
        String(node.nodeId || "").trim() === startNodeId,
    );
    if (!startNode || typeof startNode !== "object") return null;

    const welcomeText =
      typeof startNode.text === "string" && startNode.text.trim()
        ? startNode.text.trim()
        : null;
    const flow = normalizeFlowPayload({
      nodeType:
        typeof startNode.type === "string" ? String(startNode.type).trim() : "",
      options: Array.isArray(startNode.options) ? startNode.options : [],
    });

    if (!welcomeText && !flow) return null;
    return { welcomeText, flow };
  }

  /**
   * Apply workflow engine flow state to the chat input area.
   * Called whenever a bot message with flow metadata is rendered.
   */
  function applyFlowState(flow) {
    if (!flow) return;
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const msgInput = host.shadowRoot.getElementById("msgInput");
    const sendBtn = host.shadowRoot.getElementById("sendBtn");
    if (!msgInput) return;

    if (flow.isEnd) {
      msgInput.disabled = true;
      msgInput.placeholder = "Conversation ended";
      if (sendBtn) sendBtn.disabled = true;
      return;
    }

    // Re-enable in case a previous end state was reset (e.g. new conversation)
    msgInput.disabled = false;
    if (sendBtn) sendBtn.disabled = false;

    if (flow.inputType === "dropdown") {
      // Dropdown is answered via buttons — typing is not expected
      msgInput.disabled = true;
      msgInput.placeholder = "Select an option above…";
    } else if (
      flow.nodeType === "form" &&
      flow.form &&
      flow.form.mode === "popup"
    ) {
      msgInput.disabled = true;
      msgInput.placeholder = "Complete the form below…";
    } else if (flow.inputType === "email") {
      msgInput.placeholder = "Enter your email address…";
    } else if (flow.inputType === "phone") {
      msgInput.placeholder = "Enter your phone number…";
    } else if (
      flow.nodeType === "question" ||
      flow.nodeType === "form"
    ) {
      msgInput.placeholder = "Type your answer…";
    } else if (flow.nodeType === "options" || flow.options?.length > 0) {
      // Options are answered via buttons — disable free text input
      msgInput.disabled = true;
      msgInput.placeholder = "Choose an option above…";
    } else {
      // Default / AI node — restore normal placeholder
      msgInput.placeholder =
        settings?.behavior?.inputPlaceholder || "Type a message…";
    }
  }

  /**
   * Auto-start the workflow engine when the widget is first opened.
   * Sends a silent space character that boots the workflow from the start node.
   * The space is trimmed to null inside the widget renderer so it never
   * appears in the chat UI, but the backend receives a non-empty string which
   * triggers WorkflowExecutionService.handleMessage.
   */
  async function autoStartWorkflow() {
    if (workflowAutoStarted) return;
    if (!userConfig.chatbotId) return;
    workflowAutoStarted = true;

    try {
      if (!userId) {
        userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        try { localStorage.setItem(STORAGE_KEY_USER, userId); } catch (_e) {}
      }
      if (!conversationId) {
        await initializeConversation();
      }
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        const result = await connectSocket();
        if (result !== true) {
          await waitForWsConnection(5000);
        }
      }
      // Send a space — trimmed to null in widget rendering so it won't display
      // in the chat, but the backend workflow engine will treat it as the first
      // user message and boot from the start node.
      waitingForFirstInboundMessage = true;
      setInitialBodyLoading(false);
      const wsSent = wsSend({
        action: "sendMessage",
        conversationId,
        payload: {
          text: " ",
          chatbotId: userConfig.chatbotId || undefined,
        },
        userId,
      });
      scheduleOptimisticAiTypingAfterSend(wsSent);
    } catch (err) {
      console.error("UniBox: Failed to auto-start workflow", err);
      workflowAutoStarted = false; // Allow retry on next open
    }
  }

  function extractFlowPayload(message) {
    if (!message || typeof message !== "object") return null;
    const direct = normalizeFlowPayload(message.flow);
    if (direct) return direct;
    const rawPayload =
      message.raw_payload && typeof message.raw_payload === "object"
        ? message.raw_payload
        : null;
    const fromRaw = normalizeFlowPayload(rawPayload?.flow);
    if (fromRaw) return fromRaw;
    const payload =
      message.payload && typeof message.payload === "object" ? message.payload : null;
    return normalizeFlowPayload(payload?.flow);
  }

  function handleIncomingMessage(message) {
    message = normalizeSocketMessagePayload(message);
    const isUserMessage = message.sender === "user";
    const incomingAgentName =
      message.sender === "agent" ? extractVirtualAgentDisplayName(message) : null;
    const incomingAgentId =
      message.sender === "agent" ? extractVirtualAgentId(message) : null;
    const incomingTimestampMs =
      getCanonicalMessageTimestamp(message) ?? Date.now();

    const existingMessage =
      messages.get(message.messageId) ||
      Array.from(messages.values()).find(
        (msg) =>
          msg.messageId === message.messageId || msg.id === message.messageId,
      );

    if (existingMessage && existingMessage.element) {
      existingMessage.status = message.status || existingMessage.status;
      existingMessage.readAt = message.readAt || existingMessage.readAt;
      existingMessage.readByUs =
        message.readByUs !== undefined
          ? message.readByUs
          : existingMessage.readByUs;
      existingMessage.readByUsAt =
        message.readByUsAt || existingMessage.readByUsAt;
      if (incomingAgentName) existingMessage.agentName = incomingAgentName;
      if (incomingAgentId) existingMessage.agentId = incomingAgentId;
      if (message.flow) existingMessage.flow = message.flow;
      existingMessage.timestamp = incomingTimestampMs;
      existingMessage.element.setAttribute(
        "data-timestamp",
        String(incomingTimestampMs),
      );
      const timeEl =
        existingMessage.element.querySelector(".chat-widget-message-time");
      if (timeEl) {
        timeEl.textContent = formatTimestamp(incomingTimestampMs, true);
      }
      sortMessagesByTimestamp();
      return;
    }

    if (isUserMessage) {
      const optimisticMessage = Array.from(messages.values()).find((msg) => {
        if (!msg.element || msg.sender !== "user") return false;
        const localTimestampMs =
          getCanonicalMessageTimestamp(msg) ??
          toTimestampMs(msg.timestamp) ??
          Date.now();
        // RELAXED TIMING: Allow up to 30 seconds diff to account for network/server delay
        return (
          msg.text === message.text &&
          Math.abs(localTimestampMs - incomingTimestampMs) < 30000
        );
      });

      if (optimisticMessage && optimisticMessage.element) {
        const oldId = optimisticMessage.id || optimisticMessage.messageId;
        optimisticMessage.id = message.messageId;
        optimisticMessage.messageId = message.messageId;
        optimisticMessage.status = message.status || optimisticMessage.status;
        optimisticMessage.readAt = message.readAt || optimisticMessage.readAt;
        optimisticMessage.readByUs =
          message.readByUs !== undefined
            ? message.readByUs
            : optimisticMessage.readByUs;
        optimisticMessage.readByUsAt =
          message.readByUsAt || optimisticMessage.readByUsAt;
        if (incomingAgentName) optimisticMessage.agentName = incomingAgentName;
        if (incomingAgentId) optimisticMessage.agentId = incomingAgentId;
        optimisticMessage.timestamp = incomingTimestampMs;
        optimisticMessage.element.setAttribute(
          "data-message-id",
          message.messageId,
        );
        optimisticMessage.element.setAttribute(
          "data-timestamp",
          String(incomingTimestampMs),
        );
        const timeEl =
          optimisticMessage.element.querySelector(".chat-widget-message-time");
        if (timeEl) {
          timeEl.textContent = formatTimestamp(incomingTimestampMs, true);
        }
        if (oldId && oldId !== message.messageId) {
          messages.delete(oldId);
        }
        messages.set(message.messageId, optimisticMessage);
        sortMessagesByTimestamp();
        return;
      }
    }

    // Normalize text - convert empty string to null
    const textValue = message.text;
    const normalizedTextValue =
      textValue && textValue.trim() ? textValue.trim() : null;

    // Debug logging for media messages
    const isMedia =
      message.type &&
      ["image", "video", "audio", "document", "file"].includes(message.type);
    if (isMedia || message.media_storage_url) {
      console.log("UniBox: Received media message:", {
        messageId: message.messageId,
        type: message.type,
        media_storage_url: message.media_storage_url,
        text: normalizedTextValue,
        sender: message.sender,
      });
    }

    const renderIncomingMessage = () => {
      appendMessageToUI(
        normalizedTextValue,
        message.sender,
        message.messageId,
        incomingTimestampMs,
        message.status,
        message.readAt,
        message.readByUs,
        message.readByUsAt,
        message.type,
        message.media_storage_url,
        message.flow,
        message.agent_name ?? message.agentName ?? null,
        message.is_ai_reply === true || message.isAiReply === true,
      );

      if (!isUserMessage) {
        const storedMessage = messages.get(message.messageId);
        if (storedMessage) {
          if (incomingAgentName) storedMessage.agentName = incomingAgentName;
          if (incomingAgentId) storedMessage.agentId = incomingAgentId;
        }
      }

      sortMessagesByTimestamp();

      if (!isUserMessage) {
        const fromPayload = extractVirtualAgentDisplayName(message);
        const profileKeyFromPayload = extractVirtualAgentProfileKey(message);
        if (fromPayload || profileKeyFromPayload) {
          const aiReply =
            message.is_ai_reply === true || message.isAiReply === true;
          if (!aiReply) {
            maybeApplyVirtualAgentFromEvent(
              message,
              message.conversationId ?? message.conversation_id,
            );
          }
        }
        // AI/agent replied — clear all typing UI (optimistic AI + server-driven)
        clearOptimisticAiTypingSchedule();
        if (agentTypingTimeout) {
          clearTimeout(agentTypingTimeout);
          agentTypingTimeout = null;
        }
        agentTyping = false;
        showTypingIndicator(false);
        markVisibleMessagesAsRead();
      }
    };

    const normalizedFlow = extractFlowPayload(message);
    const delayMs =
      !isUserMessage &&
      normalizedFlow &&
      normalizedFlow.nodeType === "message" &&
      Number.isFinite(normalizedFlow.typingDelayMs) &&
      normalizedFlow.typingDelayMs > 0
        ? Math.max(0, Math.floor(normalizedFlow.typingDelayMs))
        : 0;
    if (delayMs > 0) {
      setTimeout(renderIncomingMessage, delayMs);
      return;
    }
    renderIncomingMessage();
  }

  /**
   * Whether AI replies are enabled for this chat (bot flow or explicit aiEnabled).
   */
  function isAiEnabled() {
    return !!(settings && settings.behavior?.aiEnabled === true);
  }

  function clearOptimisticAiTypingSchedule() {
    if (optimisticAiTypingTimer) {
      clearTimeout(optimisticAiTypingTimer);
      optimisticAiTypingTimer = null;
    }
  }

  /**
   * After a WS send attempt (sent or queued), show typing immediately and keep it
   * visible until an explicit stop/response arrives (with a safety timeout fallback).
   */
  function scheduleOptimisticAiTypingAfterSend(wsAttempted) {
    if (!wsAttempted) return;
    // Human live-chat: rely on explicit agent typing events from the server.
    if (humanLiveAgentHandoff) return;

    clearOptimisticAiTypingSchedule();
    if (agentTypingTimeout) {
      clearTimeout(agentTypingTimeout);
      agentTypingTimeout = null;
    }
    agentTyping = false;
    showTypingIndicator(false);

    // Show immediately for workflow UX: user should see bot is processing
    // until the next bot response arrives.
    optimisticAiTypingTimer = setTimeout(() => {
      optimisticAiTypingTimer = null;
      if (!humanLiveAgentHandoff) {
        agentTyping = true;
        showTypingIndicator(true, { kind: "ai", force: true });
        // Fallback auto-clear in case a downstream event is missed.
        agentTypingTimeout = setTimeout(() => {
          agentTyping = false;
          showTypingIndicator(false);
          agentTypingTimeout = null;
        }, 45000);
      }
    }, 0);
  }

  /**
   * Handle typing indicator from agent or AI (explicit roles only — no anonymous dots).
   */
  function handleTypingIndicator(data) {
    if (!data) return;

    const dataConv = data.conversationId ?? data.conversation_id;
    if (
      dataConv != null &&
      conversationId != null &&
      String(dataConv) !== String(conversationId)
    ) {
      return;
    }

    if (data.isTyping === false || data.typing === false) {
      const hasExplicitTypingActor =
        data.isAgent === true ||
        data.isAi === true ||
        (data.from && String(data.from).trim().length > 0) ||
        data.role === "agent" ||
        data.principalType === "agent" ||
        data.participant === "agent";
      // Ignore ambiguous generic stop-typing events (often presence churn).
      // We only stop typing for explicit agent/AI typing-stop signals.
      if (!hasExplicitTypingActor) {
        return;
      }
      clearOptimisticAiTypingSchedule();
      if (agentTypingTimeout) {
        clearTimeout(agentTypingTimeout);
        agentTypingTimeout = null;
      }
      agentTyping = false;
      showTypingIndicator(false);
      return;
    }

    const isFromAgent =
      data.isAgent === true ||
      (data.from && String(data.from).toLowerCase().startsWith("agent"));

    const isFromAi =
      data.isAi === true ||
      (data.from && String(data.from).toLowerCase() === "ai");
    const isGenericTypingStart =
      (data.isTyping === true || data.typing === true) && !isFromAgent && !isFromAi;

    // Many backends send generic typing start events without actor metadata.
    // Treat them as AI typing until a human agent has taken over the thread.
    const treatGenericAsAi = isGenericTypingStart && !humanLiveAgentHandoff;

    if (humanLiveAgentHandoff && isFromAi && !isFromAgent) {
      return;
    }

    let showTyping = false;
    let typingKind = "ai";
    if (isFromAgent) {
      showTyping = true;
      typingKind = "agent";
    } else if ((isFromAi || treatGenericAsAi) && !humanLiveAgentHandoff) {
      showTyping = true;
      typingKind = "ai";
    }

    if (!showTyping) {
      return;
    }

    clearOptimisticAiTypingSchedule();
    if (agentTypingTimeout) {
      clearTimeout(agentTypingTimeout);
    }

    agentTyping = true;
    showTypingIndicator(true, { kind: typingKind });

    agentTypingTimeout = setTimeout(() => {
      agentTyping = false;
      showTypingIndicator(false);
      agentTypingTimeout = null;
    }, 4000);
  }

  // --- MEDIA UPLOAD FUNCTIONS ---
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result);
      reader.onerror = (error) => reject(error);
    });
  }

  function getMediaTypeFromFile(file) {
    const type = file.type.toLowerCase();
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    if (
      type.includes("pdf") ||
      type.includes("document") ||
      type.includes("word") ||
      type.includes("excel") ||
      type.includes("sheet")
    )
      return "document";
    return "file";
  }

  function getFileChipIconFromName(fileName, mediaType) {
    const lower = String(fileName || "").toLowerCase();
    if (lower.endsWith(".pdf") || mediaType === "document") {
      return "/pulse/fileTypes/pdfFile.svg";
    }
    return "/pulse/fileTypes/jpgFile.svg";
  }

  function getMediaChipMeta(messageType, mediaKey, fallbackText) {
    const storageKey = String(mediaKey || "").trim();
    const explicitText = String(fallbackText || "").trim();
    let filename = storageKey ? storageKey.split("/").pop() || "" : "";

    if (
      !filename &&
      explicitText &&
      !explicitText.toLowerCase().includes("uploading")
    ) {
      filename = explicitText;
    }
    if (!filename) {
      filename = "file";
    }

    const label =
      filename === "file" && messageType
        ? `${String(messageType).charAt(0).toUpperCase() + String(messageType).slice(1)} File`
        : filename;

    return {
      icon: getFileChipIconFromName(filename, messageType),
      label,
    };
  }

  /**
   * @deprecated - Use presigned URL approach via WebSocket instead.
   * Upload a base64-encoded media file to S3 and get the S3 key.
   * This endpoint does NOT send the message - it only uploads to S3.
   */
  async function uploadMediaToS3(file) {
    try {
      const mediaBase64 = await fileToBase64(file);
      const mediaType = getMediaTypeFromFile(file);

      const response = await fetch(`${API_BASE}/media/upload`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          media_base64: mediaBase64,
          media_type: mediaType,
          conversationId: conversationId || undefined,
          userId: userId,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error?.message || `HTTP error! status: ${response.status}`,
        );
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.error("UniBox: Media upload error", error);
      throw error;
    }
  }

  /**
   * Validate file size (10MB limit for live chat)
   */
  function validateFileSize(file) {
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
      throw new Error(
        `File too large (${fileSizeMB}MB). Maximum size is 10MB.`,
      );
    }
    return true;
  }

  /**
   * @deprecated - Not used. The widget uses the file chips flow instead.
   * Show file preview before sending (legacy - kept for reference)
   */
  // function showFilePreview(file) {
  //   const mediaType = getMediaTypeFromFile(file);
  //   const previewUrl = URL.createObjectURL(file);
  //   previewFile = { file, previewUrl, mediaType, fileName: file.name || `file.${mediaType}` };
  //   renderPreviewModal();
  // }

  /**
   * Generate presigned URL for S3 upload using utility service
   * Same approach as agent side - uses /s3/generate-presigned-url endpoint
   */
  async function generatePresignedUploadUrl(s3Key) {
    try {
      // Use utility API base URL + /generate-presigned-url
      const endpoint = `${UTILITY_API_BASE}/generate-presigned-url`;
      console.log("UniBox: Requesting presigned URL from:", endpoint);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          key: s3Key,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to get presigned URL: ${response.status}`);
      }

      // Response can be plain text URL or JSON object
      const contentType = response.headers.get("content-type") || "";
      let presignedUrl;

      if (contentType.includes("application/json")) {
        const data = await response.json();
        // Response should have { url: presignedUrl } or { uploadUrl: presignedUrl }
        presignedUrl = data.url || data.uploadUrl || data;
      } else {
        // Plain text response - URL directly
        presignedUrl = await response.text();
      }

      // Handle case where presignedUrl is still an object
      if (typeof presignedUrl === "object" && presignedUrl !== null) {
        presignedUrl = presignedUrl.url || presignedUrl.uploadUrl;
      }

      // Trim whitespace from text response
      if (typeof presignedUrl === "string") {
        presignedUrl = presignedUrl.trim();
      }

      if (!presignedUrl || typeof presignedUrl !== "string") {
        throw new Error("No presigned URL in response");
      }

      // Validate it's a URL
      if (!presignedUrl.startsWith("http")) {
        throw new Error("Invalid presigned URL format");
      }

      console.log("UniBox: Got presigned upload URL");
      return presignedUrl;
    } catch (error) {
      console.error("UniBox: Error generating presigned URL:", error);
      throw error;
    }
  }

  /**
   * @deprecated - Use generatePresignedUploadUrl instead
   * Request presigned S3 URL for media upload via WebSocket
   */
  async function requestPresignedUrl(file) {
    const mimeType = file.type;
    const fileSize = file.size;

    // Try WebSocket first
    if (socket && socket.readyState === WebSocket.OPEN) {
      return new Promise((resolve, reject) => {
        const requestId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Set up one-time message handler
        const messageHandler = (event) => {
          try {
            const response = JSON.parse(event.data);
            if (
              response.type === "MEDIA_UPLOAD_RESPONSE" &&
              response.requestId === requestId
            ) {
              socket.removeEventListener("message", messageHandler);
              if (response.error) {
                reject(new Error(response.error));
              } else {
                resolve(response.data);
              }
            }
          } catch (e) {
            // Ignore parse errors for other messages
          }
        };

        socket.addEventListener("message", messageHandler);

        // Send request
        if (
          !wsSend({
            action: "mediaUploadRequest",
            requestId: requestId,
            conversationId: conversationId,
            mime: mimeType,
            size: fileSize,
          })
        ) {
          socket.removeEventListener("message", messageHandler);
          reject(new Error("WebSocket not connected"));
          return;
        }

        // Timeout after 10 seconds
        setTimeout(() => {
          socket.removeEventListener("message", messageHandler);
          reject(new Error("Presigned URL request timeout"));
        }, 10000);
      });
    }

    // WebSocket ONLY - no HTTP fallback for live chat
    throw new Error("WebSocket not connected - cannot request presigned URL");
  }

  /**
   * Upload file directly to S3 using presigned URL
   */
  async function uploadToS3(presignedUrl, file) {
    const response = await fetch(presignedUrl, {
      method: "PUT",
      body: file,
      headers: {
        "Content-Type": file.type,
      },
    });

    if (!response.ok) {
      throw new Error("Failed to upload file to S3");
    }

    return true;
  }

  /**
   * Generate a presigned access URL from an S3 key
   * Used for rendering media - frontend calls this to get fresh presigned URL
   * NOTE: This function is an alias for fetchMediaUrl for consistency
   * @param {string} s3Key - The S3 key (e.g., 'live-chat-media/tenant-123/file.jpg')
   * @returns {Promise<string>} - Presigned access URL
   */
  async function generateAccessUrl(s3Key) {
    // Use the existing fetchMediaUrl function which already handles this
    return fetchMediaUrl(s3Key);
  }

  /**
   * @deprecated - Not used. The widget uses sendSelectedFiles() instead.
   * This was designed for single-file preview modal flow which is not implemented.
   * The current working flow uses: addSelectedFile() → file chips → sendSelectedFiles()
   */
  async function confirmSendMedia(caption) {
    console.warn(
      "UniBox: confirmSendMedia is deprecated. Use sendSelectedFiles instead.",
    );
    if (!previewFile) return;

    const file = previewFile.file;
    const mediaType = previewFile.mediaType;
    const fileName = previewFile.fileName;

    // Validate file size
    try {
      validateFileSize(file);
    } catch (error) {
      console.error("UniBox: File validation error", error);
      alert(error.message || "File size exceeds limit");
      closePreviewModal();
      return;
    }

    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }

    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.userName = storedName;
      if (storedEmail) userDetails.userEmail = storedEmail;
    }

    // If no conversation exists, create one first
    if (!conversationId) {
      await initializeConversation();
    }

    // Show uploading indicator
    const messageId = `msg_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    try {
      // Ensure WebSocket is connected before attempting upload
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.log("UniBox: Connecting WebSocket for media upload...");
        await connectSocket();
        await waitForWsConnection(5000); // Wait up to 5 seconds for connection
      }

      // Show uploading indicator
      appendMessageToUI(
        `Uploading ${fileName}...`,
        "user",
        messageId,
        new Date(),
        "sent",
        null,
        false,
        null,
        mediaType,
        null,
      );

      // Step 1: Request presigned URL (returns uploadUrl, fileUrl, and s3Key)
      console.log("UniBox: Requesting presigned URL for media upload...");
      const uploadData = await requestPresignedUrl(file);
      console.log(
        "UniBox: Received upload data:",
        uploadData ? "success" : "null",
      );

      const uploadUrl = uploadData?.uploadUrl;
      const s3Key = uploadData?.s3Key;

      if (!uploadUrl || !s3Key) {
        console.error(
          "UniBox: Missing uploadUrl or s3Key in response:",
          uploadData,
        );
        throw new Error("Failed to get upload URL from server");
      }

      // Step 2: Upload directly to S3
      console.log("UniBox: Uploading file to S3...");
      await uploadToS3(uploadUrl, file);
      console.log("UniBox: S3 upload complete");

      // Step 3: Send message with S3 KEY (not full URL) via WebSocket
      // Frontend will call generate-access-url to render the media
      // Send media message via WebSocket ONLY - no HTTP fallback
      const wsSent = wsSend({
        action: "sendMessage",
        conversationId: conversationId,
        payload: {
          text: caption || fileName,
          url: s3Key, // Send S3 key, not presigned URL
          type: mediaType,
        },
        userId: userId,
        userName: userDetails.userName,
        userEmail: userDetails.userEmail,
      });

      if (!wsSent) {
        // WebSocket not ready - message is queued and will be sent when connected
        console.log("UniBox: Media message queued for WebSocket delivery");
      } else {
        console.log("UniBox: Media message sent successfully via WebSocket");
      }

      // Close preview modal on success
      closePreviewModal();

      // Message will be received via WebSocket and added automatically
    } catch (error) {
      console.error("UniBox: Send Media Error", error);

      // Remove uploading indicator and show error
      const host = document.getElementById("unibox-root");
      if (host && host.shadowRoot) {
        const body = host.shadowRoot.getElementById("chatBody");
        if (body) {
          const uploadingMsg = body.querySelector(
            `[data-message-id="${messageId}"]`,
          );
          if (uploadingMsg) {
            uploadingMsg.remove();
            messages.delete(messageId);
          }
        }
      }

      closePreviewModal();
      alert(error.message || "Failed to upload media. Please try again.");
    }
  }

  /**
   * Add file to selected files and show as chip
   */
  function addSelectedFile(file) {
    try {
      const mediaType = getMediaTypeFromFile(file);
      let previewUrl = null;

      try {
        previewUrl = URL.createObjectURL(file);
      } catch (err) {
        console.warn("UniBox: Could not create preview URL for file", err);
      }

      selectedFiles.push({
        file: file,
        previewUrl: previewUrl,
        mediaType: mediaType,
        fileName: file.name || `file.${mediaType}`,
      });

      // Use setTimeout to avoid blocking the main thread
      setTimeout(() => {
        try {
          renderFileChips();
        } catch (err) {
          console.error("UniBox: Error rendering file chips", err);
        }
      }, 0);

      // Update send button state
      const host = document.getElementById("unibox-root");
      if (host && host.shadowRoot) {
        const sendBtn = host.shadowRoot.getElementById("sendBtn");
        if (sendBtn) {
          const msgInput = host.shadowRoot.getElementById("msgInput");
          const hasText = msgInput && msgInput.value.trim().length > 0;
          const hasFiles = selectedFiles.length > 0;
          sendBtn.disabled = !hasText && !hasFiles;
          sendBtn.style.opacity = hasText || hasFiles ? "1" : "0.5";
          sendBtn.style.cursor =
            hasText || hasFiles ? "pointer" : "not-allowed";
        }
      }
    } catch (err) {
      console.error("UniBox: Error adding selected file", err);
    }
  }

  /**
   * Remove file from selected files
   */
  function removeSelectedFile(index) {
    if (selectedFiles[index] && selectedFiles[index].previewUrl) {
      URL.revokeObjectURL(selectedFiles[index].previewUrl);
    }
    selectedFiles.splice(index, 1);
    renderFileChips();

    // Update send button state
    const host = document.getElementById("unibox-root");
    if (host && host.shadowRoot) {
      const sendBtn = host.shadowRoot.getElementById("sendBtn");
      if (sendBtn) {
        const msgInput = host.shadowRoot.getElementById("msgInput");
        const hasText = msgInput && msgInput.value.trim().length > 0;
        const hasFiles = selectedFiles.length > 0;
        sendBtn.disabled = !hasText && !hasFiles;
        sendBtn.style.opacity = hasText || hasFiles ? "1" : "0.5";
        sendBtn.style.cursor = hasText || hasFiles ? "pointer" : "not-allowed";
      }
    }
  }

  // Track pending render timeout to prevent multiple concurrent retries
  let renderChipsTimeout = null;
  let renderChipsRetryCount = 0;
  const MAX_RENDER_RETRIES = 10;

  /**
   * Render file chips above input field (like MessageInput.tsx)
   */
  function renderFileChips() {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;

    const footerSection = host.shadowRoot.getElementById("chatFooterSection");
    const footer = host.shadowRoot.getElementById("chatFooter");
    if (!footerSection || !footer) {
      // Footer might not be ready yet, try again after a short delay (with limit)
      if (renderChipsRetryCount < MAX_RENDER_RETRIES) {
        renderChipsRetryCount++;
        // Clear any pending timeout first
        if (renderChipsTimeout) {
          clearTimeout(renderChipsTimeout);
        }
        renderChipsTimeout = setTimeout(renderFileChips, 100);
      } else {
        console.warn(
          "UniBox: Footer not found after max retries, skipping chip render",
        );
        renderChipsRetryCount = 0;
      }
      return;
    }

    // Reset retry count on success
    renderChipsRetryCount = 0;
    if (renderChipsTimeout) {
      clearTimeout(renderChipsTimeout);
      renderChipsTimeout = null;
    }

    // Ensure footer section is visible
    footerSection.classList.remove("hidden");

    // Remove existing chips container
    const existingChips = host.shadowRoot.getElementById("fileChipsContainer");
    if (existingChips) {
      existingChips.remove();
    }

    // If no files, don't render anything
    if (selectedFiles.length === 0) return;

    // Create chips container
    const chipsContainer = document.createElement("div");
    chipsContainer.id = "fileChipsContainer";
    chipsContainer.className = "file-chips-container";
    chipsContainer.style.display = "flex";
    chipsContainer.style.flexWrap = "wrap";
    chipsContainer.style.gap = "8px";
    chipsContainer.style.padding = "12px 16px";
    chipsContainer.style.borderBottom = "1px solid #e5e7eb";
    chipsContainer.style.backgroundColor = "#ffffff";
    chipsContainer.style.width = "100%";
    chipsContainer.style.boxSizing = "border-box";

    selectedFiles.forEach((fileData, index) => {
      const chip = document.createElement("div");
      chip.style.display = "flex";
      chip.style.alignItems = "center";
      chip.style.gap = "8px";
      chip.style.height = "36px";
      chip.style.padding = "0 12px";
      chip.style.borderRadius = "6px";
      chip.style.backgroundColor = "#ffffff";
      chip.style.border = "1px solid #EFEFEF";
      chip.style.fontSize = "14px";
      chip.style.fontFamily = resolvedFontFamily || "DM Sans, sans-serif";
      chip.style.fontWeight = "400";
      chip.style.lineHeight = "20px";
      chip.style.color = "#18181E";

      const iconImg = document.createElement("img");
      iconImg.src = getFileChipIconFromName(
        fileData.fileName,
        fileData.mediaType,
      );
      iconImg.alt = "File";
      iconImg.width = 20;
      iconImg.height = 20;
      iconImg.style.flexShrink = "0";

      // File name
      const nameSpan = document.createElement("span");
      nameSpan.style.overflow = "hidden";
      nameSpan.style.textOverflow = "ellipsis";
      nameSpan.style.whiteSpace = "nowrap";
      nameSpan.style.maxWidth = "180px";
      nameSpan.textContent = fileData.fileName;

      // Remove button (matching MessageInput.tsx style)
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.style.display = "flex";
      removeBtn.style.alignItems = "center";
      removeBtn.style.justifyContent = "center";
      removeBtn.style.padding = "4px";
      removeBtn.style.backgroundColor = "transparent";
      removeBtn.style.border = "none";
      removeBtn.style.cursor = "pointer";
      removeBtn.style.borderRadius = "4px";
      removeBtn.style.flexShrink = "0";
      removeBtn.style.transition = "background-color 0.2s";
      removeBtn.onmouseenter = () => {
        removeBtn.style.backgroundColor = "#f3f4f6";
      };
      removeBtn.onmouseleave = () => {
        removeBtn.style.backgroundColor = "transparent";
      };
      removeBtn.onclick = () => removeSelectedFile(index);
      const removeIcon = document.createElement("img");
      removeIcon.src = "/icons/x.svg";
      removeIcon.alt = "Remove";
      removeIcon.width = 14;
      removeIcon.height = 14;
      removeBtn.appendChild(removeIcon);

      chip.appendChild(iconImg);
      chip.appendChild(nameSpan);
      chip.appendChild(removeBtn);
      chipsContainer.appendChild(chip);
    });

    // Insert chips container ABOVE the footer (before footer element)
    // This places it between chat body and footer
    footer.parentElement.insertBefore(chipsContainer, footer);

    // Ensure chips are visible
    chipsContainer.style.display = "flex";
    chipsContainer.style.visibility = "visible";
    chipsContainer.style.opacity = "1";
  }

  /**
   * Send all selected files with caption
   * FAST PATH: Generate S3 key -> Show UI -> Send WebSocket -> Upload in background
   */
  async function sendSelectedFiles(caption) {
    if (selectedFiles.length === 0) return;

    // Get user details
    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.userName = storedName;
      if (storedEmail) userDetails.userEmail = storedEmail;
    }

    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }

    // If no conversation exists, create one first
    if (!conversationId) {
      await initializeConversation();
    }

    // Ensure WebSocket is connected
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      await connectSocket();
      await waitForWsConnection(5000);
    }

    // Send each file - copy the array but DON'T revoke URLs yet (need them for optimistic UI)
    const filesToSend = [...selectedFiles];

    // Clear selected files array but don't revoke URLs yet
    selectedFiles = [];
    renderFileChips();

    // Get tenantId from config
    const tenantId = fetchedConfig?.tenantId || "unknown";

    let anyMediaWsAttempted = false;

    for (const fileData of filesToSend) {
      const file = fileData.file;
      const mediaType = fileData.mediaType;
      const fileName = fileData.fileName;
      const localPreviewUrl = fileData.previewUrl; // Keep for optimistic UI - will be revoked after upload

      // Validate file size
      try {
        validateFileSize(file);
      } catch (error) {
        console.error("UniBox: File validation error", error);
        alert(error.message || "File size exceeds limit");
        continue;
      }

      // FAST PATH: Same as agent side
      // Generate S3 key -> Show chip UI -> Send WebSocket -> Upload in background
      console.log("📤 Widget media upload - FAST PATH...");

      // Step 1: Generate random S3 key locally (instant)
      const fileExt = fileName.split(".").pop() || "bin";
      const randomId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const s3Key = `live-chat-media/${tenantId}/${conversationId}/${randomId}.${fileExt}`;
      const messageId = `msg_media_${randomId}`;
      console.log("1️⃣ Generated S3 key:", s3Key);

      // Step 2: Show chip UI immediately (no loading state - same as agent side)
      // Use s3Key as mediaStorageUrl so it shows as a chip, not inline image
      appendMessageToUI(
        caption || "", // Caption only, NOT filename
        "user",
        messageId,
        new Date(),
        "delivered", // Show as sent immediately (no loading state)
        null, // readAt
        false, // readByUs
        null, // readByUsAt
        mediaType,
        s3Key, // Use S3 key so it shows as a chip
      );
      console.log("2️⃣ Chip UI shown");

      // Step 3: Send message via WebSocket with S3 KEY (instant)
      const wsSent = wsSend({
        action: "sendMessage",
        conversationId: conversationId,
        payload: {
          text: caption || "", // Caption only, NOT filename
          url: s3Key, // S3 key
          type: mediaType,
        },
        userId: userId,
        userName: userDetails.userName,
        userEmail: userDetails.userEmail,
      });

      if (wsSent) {
        console.log("3️⃣ Message sent via WebSocket with S3 key:", s3Key);
      } else {
        console.log("3️⃣ Message queued for WebSocket delivery");
      }
      anyMediaWsAttempted = true;

      // Cleanup local preview URL immediately (not needed for chip display)
      if (localPreviewUrl && localPreviewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(localPreviewUrl);
      }

      // Step 4 & 5: Get presigned URL via utility service and upload in background
      (async () => {
        try {
          console.log("4️⃣ Requesting presigned URL via utility service...");
          const presignedUrl = await generatePresignedUploadUrl(s3Key);
          console.log("✅ Got presigned URL");

          console.log("5️⃣ Uploading to S3...");
          await uploadToS3(presignedUrl, file);
          console.log("✅ File uploaded to S3");

          // Upload complete - message already shown with 'sent' status
          console.log("✅ Media upload complete for:", s3Key);
        } catch (uploadError) {
          console.error("❌ Background upload failed:", uploadError);
          // Update message status to failed
          const existingMsg = messages.get(messageId);
          if (existingMsg) {
            existingMsg.status = "failed";
            // Update UI to show failed status
            const host = document.getElementById("unibox-root");
            if (host && host.shadowRoot) {
              const msgEl = host.shadowRoot.querySelector(
                `[data-message-id="${messageId}"]`,
              );
              if (msgEl) {
                const chip = msgEl.querySelector(".chat-widget-media-chip");
                if (chip) {
                  chip.style.borderColor = "#ef4444";
                  chip.style.backgroundColor = "#fef2f2";
                }
              }
            }
          }
        }
      })();
    }

    if (anyMediaWsAttempted) {
      scheduleOptimisticAiTypingAfterSend(true);
    }
  }

  /**
   * Add file to selected files (shows as chip above input)
   */
  async function sendMediaMessage(file) {
    // Validate file size first
    try {
      validateFileSize(file);
    } catch (error) {
      console.error("UniBox: File validation error", error);
      alert(error.message || "File size exceeds limit");
      return;
    }

    // Add to selected files (will show as chip)
    addSelectedFile(file);
  }

  /**
   * Send text message via WebSocket
   * Falls back to HTTP API if WebSocket is not available
   */
  async function sendMessageToApi(text, payloadOverrides) {
    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }

    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.userName = storedName;
      if (storedEmail) userDetails.userEmail = storedEmail;
    }

    let preChatContext = null;
    if (hasSubmittedForm) {
      try {
        const storedFormData = sessionStorage.getItem(SESSION_KEY_FORM_DATA);
        const storedFieldMappings = sessionStorage.getItem(SESSION_KEY_FORM_MAPPINGS);
        const parsedFormData = storedFormData ? JSON.parse(storedFormData) : null;
        const parsedFieldMappings = storedFieldMappings
          ? JSON.parse(storedFieldMappings)
          : null;
        if (parsedFormData && typeof parsedFormData === "object") {
          preChatContext = {
            formData: parsedFormData,
            fieldMappings: Array.isArray(parsedFieldMappings)
              ? parsedFieldMappings
              : [],
          };
        }
      } catch (err) {
        console.warn("UniBox: Failed to parse pre-chat context", err);
      }
    }

    try {
      // If no conversation exists, create one first (silently, no loading state)
      if (!conversationId) {
        await initializeConversation();
      }

      // Connect socket if needed and wait for connection
      if (conversationId) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          console.log(
            "UniBox: Waiting for WebSocket connection before sending...",
          );
          const connectResult = await connectSocket();

          // If connectSocket returned a promise or false, wait for connection
          if (connectResult !== true) {
            const connected = await waitForWsConnection(5000);
            if (!connected) {
              console.log(
                "UniBox: WebSocket connection not ready, will use HTTP fallback",
              );
            } else {
              console.log("UniBox: WebSocket now connected");
            }
          }
        }
      }

      // Send via WebSocket ONLY - no HTTP fallback for live chat
      // NOTE: Optimistic UI append is handled by the caller (handleSend) before
      // invoking this function, so we do NOT call appendMessageToUI here.
      const wsSent = wsSend({
        action: "sendMessage",
        conversationId: conversationId,
        payload: Object.assign(
          {
            text: text,
            // Always include chatbotId so the backend can resolve the published
            // workflow even when conversation metadata hasn't been set yet.
            chatbotId: userConfig.chatbotId || undefined,
          },
          (() => {
            const basePayload =
              payloadOverrides && typeof payloadOverrides === "object"
                ? payloadOverrides
                : {};
            if (!preChatContext) return basePayload;
            const mergedInteractivePayload =
              basePayload.interactivePayload &&
              typeof basePayload.interactivePayload === "object"
                ? Object.assign({}, basePayload.interactivePayload, {
                    preChatContext,
                  })
                : { preChatContext };
            return Object.assign({}, basePayload, {
              interactivePayload: mergedInteractivePayload,
            });
          })(),
        ),
        userId: userId,
        userName: userDetails.userName,
        userEmail: userDetails.userEmail,
      });

      // Optimistic typing: show the "bot is processing" indicator immediately
      // after every user send.  The indicator is cleared automatically when the
      // first bot reply arrives (see renderIncomingMessage) or when the server
      // sends an explicit typing:false event (handleTypingIndicator).
      // In human live-chat sessions scheduleOptimisticAiTypingAfterSend is a no-op.
      scheduleOptimisticAiTypingAfterSend(wsSent);

      if (wsSent) {
        console.log("UniBox: Message sent via WebSocket");
      } else {
        // WebSocket not ready - message is queued and will be sent when connected
        console.log("UniBox: Message queued for WebSocket delivery");
      }

      return { success: true };
    } catch (error) {
      console.error("UniBox: Send Error", error);
      const host = document.getElementById("unibox-root");
      if (host && host.shadowRoot) {
        const body = host.shadowRoot.getElementById("chatBody");
        if (body) {
          const errDiv = document.createElement("div");
          errDiv.style.textAlign = "center";
          errDiv.style.fontSize = "12px";
          errDiv.style.color = "red";
          errDiv.innerText = "Failed to deliver message";
          body.appendChild(errDiv);
        }
      }
      throw error;
    }
  }

  /**
   * @deprecated - Messages now arrive via WebSocket, not HTTP polling.
   * This function is kept for potential fallback use but is not called.
   *
   * Fetch and render the latest conversation thread after a user message is sent.
   * Clears and re-renders all messages from the server response to ensure correct order
   * and eliminate any glitches from optimistic updates.
   */
  async function fetchAndRenderThreadAfterSend() {
    if (!userId) return;

    try {
      // Wait a bit for backend to process the message and generate bot response
      await new Promise((resolve) => setTimeout(resolve, 800));

      const threadRes = await fetch(`${API_BASE}/thread/${userId}?limit=50`, {
        method: "GET",
        headers: getHeaders(),
      });

      if (!threadRes.ok) {
        return;
      }

      const threadData = await threadRes.json();
      if (threadData.messages && Array.isArray(threadData.messages)) {
        // Clear all messages to avoid any glitches or ordering issues
        const host = document.getElementById("unibox-root");
        if (host && host.shadowRoot) {
          const body = host.shadowRoot.getElementById("chatBody");
          if (body) {
            // Remove all message elements (but preserve typing indicator)
            const allMessages = body.querySelectorAll(".chat-widget-message");
            allMessages.forEach((msg) => msg.remove());

            // Clear the messages map
            messages.clear();
            staticWelcomeShown = false;

            // Make sure typing indicator is still in the body
            const typingIndicator = body.querySelector("#typingIndicator");
            if (!typingIndicator) {
              const newTypingIndicator = document.createElement("div");
              newTypingIndicator.className =
                "chat-widget-typing-indicator hidden";
              newTypingIndicator.id = "typingIndicator";
              newTypingIndicator.innerHTML = `
              <div class="chat-widget-typing-dots" aria-live="polite" aria-label="Typing">
                <div class="chat-widget-typing-dot"></div>
                <div class="chat-widget-typing-dot"></div>
                <div class="chat-widget-typing-dot"></div>
              </div>
            `;
              body.appendChild(newTypingIndicator);
            }
          }
        }

        // Now render all messages from thread in correct order
        const replayActivePopupFormMessageId =
          getReplayActivePopupFormMessageId(threadData.messages);
        const replayActiveChoiceMessageId =
          getReplayActiveChoiceMessageId(threadData.messages);
        threadData.messages.forEach((msg) => {
          // Normalize text - convert empty string to null
          const textValue = msg.text || msg.text_body;
          const normalizedTextValue =
            textValue && textValue.trim() ? textValue.trim() : null;

          const canonicalTimestamp =
            (typeof msg.timestamp === "number" && msg.timestamp) ||
            (msg.timestamp_iso
              ? msg.timestamp_iso
              : typeof msg.timestamp_meta === "number"
                ? msg.timestamp_meta * 1000
                : undefined);

          appendMessageToUI(
            normalizedTextValue,
            msg.sender || (msg.direction === "inbound" ? "user" : "agent"),
            msg.id || msg.messageId,
            canonicalTimestamp,
            msg.status,
            msg.readAt,
            msg.readByUs,
            msg.readByUsAt,
            msg.type,
            msg.media_storage_url,
            extractFlowPayload(msg),
            msg.agentName ?? msg.agent_name ?? null,
            msg.is_ai_reply === true || msg.isAiReply === true,
            (msg.id || msg.messageId) === replayActivePopupFormMessageId,
            (msg.id || msg.messageId) === replayActiveChoiceMessageId,
          );
        });

        // Messages from API should already be in correct order, but sort to be safe
        sortMessagesByTimestamp();
        markVisibleMessagesAsRead();
      }
    } catch (e) {
      console.error("UniBox: Failed to fetch thread after message", e);
    }
  }

  /**
   * Show media preview in popup modal
   */
  async function showMediaPreview(mediaKey, mediaType, caption) {
    if (previewMediaRefreshTimer) {
      clearInterval(previewMediaRefreshTimer);
      previewMediaRefreshTimer = null;
    }
    // Check if this is a local blob URL (for optimistic display)
    const isBlobUrl = mediaKey && mediaKey.startsWith("blob:");

    previewMedia = {
      mediaKey: mediaKey,
      mediaType: mediaType,
      caption: caption,
      url: isBlobUrl ? mediaKey : null, // Use blob URL directly if available
      filename: isBlobUrl ? "Preview" : mediaKey.split("/").pop() || "file",
      isLoading: !isBlobUrl, // Don't show loading for blob URLs
    };

    renderPreviewModal();

    // Skip fetch for blob URLs
    if (isBlobUrl) {
      return;
    }

    // Fetch media URL for S3 keys
    try {
      const url = await fetchMediaUrl(mediaKey);
      if (url) {
        previewMedia.url = url;
        previewMedia.isLoading = false;
        renderPreviewModal();
        // Refresh URL periodically while preview stays open; signed links expire in 30-60 mins.
        previewMediaRefreshTimer = setInterval(async () => {
          if (!previewMedia || previewMedia.mediaKey !== mediaKey) return;
          try {
            const refreshed = await fetchMediaUrl(mediaKey, { forceRefresh: true });
            if (refreshed && previewMedia && previewMedia.mediaKey === mediaKey) {
              previewMedia.url = refreshed;
              previewMedia.error = false;
              renderPreviewModal();
            }
          } catch (e) {
            // Keep current preview URL until the next refresh attempt.
          }
        }, 25 * 60 * 1000);
      } else {
        throw new Error("Failed to load media");
      }
    } catch (error) {
      console.error("UniBox: Error loading media preview", error);
      previewMedia.isLoading = false;
      previewMedia.error = true;
      renderPreviewModal();
    }
  }

  /**
   * Render preview modal for file upload or media viewing
   */
  function renderPreviewModal() {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;

    let modal = host.shadowRoot.getElementById("chatWidgetPreviewModal");

    // Remove existing modal
    if (modal) {
      modal.remove();
    }

    // Don't render if no preview (only for viewing received media)
    if (!previewMedia) return;

    // Create modal
    modal = document.createElement("div");
    modal.id = "chatWidgetPreviewModal";
    modal.className = "chat-widget-preview-modal";
    modal.style.position = "fixed";
    modal.style.top = "0";
    modal.style.left = "0";
    modal.style.right = "0";
    modal.style.bottom = "0";
    modal.style.backgroundColor = "rgba(0, 0, 0, 0.5)";
    modal.style.display = "flex";
    modal.style.alignItems = "center";
    modal.style.justifyContent = "center";
    modal.style.zIndex = "2147483648";
    modal.onclick = (e) => {
      if (e.target === modal) {
        closePreviewModal();
      }
    };

    const modalContent = document.createElement("div");
    modalContent.className = "chat-widget-preview-content";
    modalContent.style.backgroundColor = "#ffffff";
    modalContent.style.borderRadius = "12px";
    modalContent.style.padding = "20px";
    modalContent.style.maxWidth = "90vw";
    modalContent.style.maxHeight = "90vh";
    modalContent.style.overflow = "auto";
    modalContent.style.position = "relative";
    modalContent.style.boxShadow = "0 8px 30px rgba(0, 0, 0, 0.3)";
    modalContent.onclick = (e) => e.stopPropagation();

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.innerHTML = "&times;";
    closeBtn.style.position = "absolute";
    closeBtn.style.top = "10px";
    closeBtn.style.right = "10px";
    closeBtn.style.width = "32px";
    closeBtn.style.height = "32px";
    closeBtn.style.border = "none";
    closeBtn.style.backgroundColor = "transparent";
    closeBtn.style.fontSize = "24px";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.color = "#6b7280";
    closeBtn.style.borderRadius = "50%";
    closeBtn.style.display = "flex";
    closeBtn.style.alignItems = "center";
    closeBtn.style.justifyContent = "center";
    closeBtn.onmouseenter = () => {
      closeBtn.style.backgroundColor = "#f3f4f6";
    };
    closeBtn.onmouseleave = () => {
      closeBtn.style.backgroundColor = "transparent";
    };
    closeBtn.onclick = closePreviewModal;

    if (previewMedia) {
      const previewContainer = document.createElement("div");
      previewContainer.style.display = "flex";
      previewContainer.style.flexDirection = "column";
      previewContainer.style.gap = "16px";
      previewContainer.style.alignItems = "center";

      if (previewMedia.isLoading) {
        const loadingDiv = document.createElement("div");
        loadingDiv.style.padding = "40px";
        loadingDiv.style.textAlign = "center";
        loadingDiv.innerHTML = `
          <div style="width: 32px; height: 32px; border: 3px solid transparent; border-bottom-color: #8D53F8; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto;" role="status" aria-label="Loading"></div>
        `;
        previewContainer.appendChild(loadingDiv);
      } else if (previewMedia.error) {
        const errorDiv = document.createElement("div");
        errorDiv.style.padding = "40px";
        errorDiv.style.textAlign = "center";
        errorDiv.style.color = "#ef4444";
        errorDiv.innerHTML = `
          <div style="font-size: ${fontSizes.body};">Failed to load media</div>
        `;
        previewContainer.appendChild(errorDiv);
      } else if (previewMedia.url) {
        if (previewMedia.mediaType === "image") {
          const img = document.createElement("img");
          img.src = previewMedia.url;
          img.style.maxWidth = "100%";
          img.style.maxHeight = "70vh";
          img.style.borderRadius = "8px";
          img.style.objectFit = "contain";
          previewContainer.appendChild(img);
        } else if (previewMedia.mediaType === "video") {
          const video = document.createElement("video");
          video.src = previewMedia.url;
          video.controls = true;
          video.style.maxWidth = "100%";
          video.style.maxHeight = "70vh";
          video.style.borderRadius = "8px";
          previewContainer.appendChild(video);
        } else if (previewMedia.mediaType === "audio") {
          const audio = document.createElement("audio");
          audio.src = previewMedia.url;
          audio.controls = true;
          audio.style.width = "100%";
          previewContainer.appendChild(audio);
        } else {
          const fileLink = document.createElement("a");
          fileLink.href = previewMedia.url;
          fileLink.target = "_blank";
          fileLink.style.display = "inline-block";
          fileLink.style.padding = "12px 20px";
          fileLink.style.backgroundColor =
            settings.appearance.gradientColor1 ||
            settings.appearance.primaryColor ||
            "#912FF5";
          fileLink.style.color = "#ffffff";
          fileLink.style.borderRadius = "6px";
          fileLink.style.textDecoration = "none";
          fileLink.style.fontSize = "14px";
          fileLink.style.fontWeight = "500";
          fileLink.textContent = `Download ${previewMedia.filename}`;
          previewContainer.appendChild(fileLink);
        }

        if (previewMedia.caption) {
          const captionDiv = document.createElement("div");
          captionDiv.style.textAlign = "center";
          captionDiv.style.color = "#6b7280";
          captionDiv.style.fontSize = "14px";
          captionDiv.style.marginTop = "8px";
          captionDiv.textContent = previewMedia.caption;
          previewContainer.appendChild(captionDiv);
        }
      }

      modalContent.appendChild(previewContainer);
    }

    modalContent.appendChild(closeBtn);
    modal.appendChild(modalContent);
    host.shadowRoot.appendChild(modal);
  }

  /**
   * Close preview modal
   */
  function closePreviewModal() {
    if (previewMediaRefreshTimer) {
      clearInterval(previewMediaRefreshTimer);
      previewMediaRefreshTimer = null;
    }
    previewMedia = null;

    const host = document.getElementById("unibox-root");
    if (host && host.shadowRoot) {
      const modal = host.shadowRoot.getElementById("chatWidgetPreviewModal");
      if (modal) {
        modal.remove();
      }
    }
  }

  function formatTimestamp(timestamp, showReadReceipt = false) {
    if (!timestamp) return "";
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);

    if (showReadReceipt) {
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, "0");
      const ampm = hours >= 12 ? "PM" : "AM";
      hours = hours % 12;
      hours = hours ? hours : 12;
      const hoursStr = hours.toString().padStart(2, "0");
      return `${hoursStr}:${minutes} ${ampm}`;
    }

    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    let hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12;
    hours = hours || 12;
    const hoursStr = hours.toString().padStart(2, "0");
    const day = date.getDate();
    const month = date.toLocaleString("default", { month: "short" });
    return `${day} ${month}, ${hoursStr}:${minutes} ${ampm}`;
  }

  function getReadReceiptIcon(status, readAt, readByUs, readByUsAt, sender) {
    if (sender !== "user") return "";
    if (readByUs && readByUsAt) {
      return `<span class="chat-widget-read-receipt" aria-hidden="true"><svg class="chat-widget-read-receipt-icon" width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.8334 8.05566L7.81258 15.8334L4.16675 12.2981" stroke="#8D53F8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.8334 4.16699L7.81258 11.9448L4.16675 8.40942" stroke="#8D53F8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
    }
    return `<span class="chat-widget-read-receipt" aria-hidden="true"><svg class="chat-widget-read-receipt-icon" width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" style="opacity:0.5"><path d="M15.8334 8.05566L7.81258 15.8334L4.16675 12.2981" stroke="#9DA2AB" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.8334 4.16699L7.81258 11.9448L4.16675 8.40942" stroke="#9DA2AB" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  }

  // Helper function to check if a message is a welcome message
  function isWelcomeMessage(text) {
    if (!text) return false;
    const welcomeText =
      settings.appearance.header?.welcomeMessage ||
      settings.appearance.welcomeMessage;
    if (!welcomeText) return false;
    return text.trim().toLowerCase() === welcomeText.trim().toLowerCase();
  }

  function extractPopupFormConfig(flow) {
    const toTitleCaseWords = (input) => {
      return String(input || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => {
          if (!word) return word;
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(" ");
    };
    const humanizeFieldKey = (rawKey) => {
      const key = String(rawKey || "").trim();
      if (!key) return "";
      return toTitleCaseWords(
        key
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replace(/[_-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      );
    };
    const normalizeFieldPrompt = (rawPrompt, key) => {
      const prompt = String(rawPrompt || "").trim();
      const fallback = humanizeFieldKey(key);
      if (!prompt) return fallback;
      // If prompt is provided but key-like (e.g., "contactNumber"), normalize it too.
      const looksLikeKey = /^[a-z0-9_-]+$/.test(prompt) || /[a-z][A-Z]/.test(prompt);
      return looksLikeKey ? humanizeFieldKey(prompt) : toTitleCaseWords(prompt);
    };
    const mode = String(flow?.form?.mode || flow?.form?.formMode || "")
      .trim()
      .toLowerCase();
    if (
      !flow ||
      flow.nodeType !== "form" ||
      !flow.form ||
      mode !== "popup" ||
      !Array.isArray(flow.form.fields)
    ) {
      return null;
    }
    const nodeId =
      typeof flow.nodeId === "string" && flow.nodeId.trim()
        ? flow.nodeId.trim()
        : "";
    const fields = flow.form.fields
      .map((field) => {
        if (!field || typeof field !== "object") return null;
        const key =
          typeof field.key === "string" && field.key.trim()
            ? field.key.trim()
            : "";
        if (!key) return null;
        const promptText =
          normalizeFieldPrompt(
            typeof field.prompt === "string" ? field.prompt : "",
            key,
          ) || humanizeFieldKey(key);
        return {
          key,
          prompt: promptText,
          inputType:
            typeof field.inputType === "string"
              ? field.inputType.trim().toLowerCase()
              : "text",
          required: Boolean(field.required),
          retryMessage:
            typeof field.retryMessage === "string"
              ? field.retryMessage.trim()
              : "",
          crmPath:
            typeof field.crmPath === "string" ? field.crmPath.trim() : "",
          options: Array.isArray(field.options)
            ? field.options
                .map((option) => String(option ?? "").trim())
                .filter(Boolean)
            : [],
        };
      })
      .filter(Boolean);
    if (!nodeId || fields.length === 0) return null;
    return {
      nodeId,
      formTitle:
        typeof flow.form.formTitle === "string" && flow.form.formTitle.trim()
          ? flow.form.formTitle.trim()
          : "Please fill the form",
      fields,
    };
  }

  function isPopupFormReadyToSubmit(config) {
    if (!config || !Array.isArray(config.fields) || config.fields.length === 0) {
      return false;
    }
    return config.fields.every((field) => {
      if (!field || !field.required) return true;
      const value = String(popupFormValues[field.key] || "").trim();
      return value.length > 0;
    });
  }

  function getReplayActivePopupFormMessageId(threadMessages) {
    if (!Array.isArray(threadMessages) || threadMessages.length === 0) return null;
    const lastMessage = threadMessages[threadMessages.length - 1];
    if (!lastMessage || String(lastMessage.sender || "").toLowerCase() !== "agent") {
      return null;
    }
    const flow = extractFlowPayload(lastMessage);
    const mode = String(flow?.form?.mode || flow?.form?.formMode || "")
      .trim()
      .toLowerCase();
    if (flow?.nodeType !== "form" || mode !== "popup") return null;
    return String(lastMessage.id || lastMessage.messageId || "").trim() || null;
  }

  function getReplayActiveChoiceMessageId(threadMessages) {
    if (!Array.isArray(threadMessages) || threadMessages.length === 0) return null;
    const lastMessage = threadMessages[threadMessages.length - 1];
    if (!lastMessage || String(lastMessage.sender || "").toLowerCase() !== "agent") {
      return null;
    }
    const flow = extractFlowPayload(lastMessage);
    const hasOptions =
      Array.isArray(flow?.options) && flow.options.filter(Boolean).length > 0;
    const hasDropdownOptions =
      String(flow?.inputType || "").toLowerCase() === "dropdown" &&
      Array.isArray(flow?.dropdownOptions) &&
      flow.dropdownOptions.filter(Boolean).length > 0;
    if (!hasOptions && !hasDropdownOptions) return null;
    return String(lastMessage.id || lastMessage.messageId || "").trim() || null;
  }

  // --- UPDATED APPEND MESSAGE FUNCTION WITH FIX ---
  function appendMessageToUI(
    text,
    type,
    messageId,
    timestamp,
    status,
    readAt,
    readByUs,
    readByUsAt,
    messageType,
    mediaStorageUrl,
    flowData,
    agentLabelOverride,
    isAiReply,
    allowPopupFormActivation = true,
    allowFlowChoiceUi = true,
  ) {
    const normalizedAgentLabel =
      typeof agentLabelOverride === "string" && agentLabelOverride.trim()
        ? agentLabelOverride.trim()
        : null;
    const useHumanAgentLabel =
      type === "agent" && isAiReply !== true && Boolean(normalizedAgentLabel);
    const bubbleAgentLabel = useHumanAgentLabel
      ? normalizedAgentLabel
      : "Pulse AI";

    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById("chatBody");
    if (!body) return;

    // Normalize text - handle null/undefined/empty string
    // Convert empty string to null for consistent handling
    const normalizedText = text && text.trim() ? text.trim() : null;
    const normalizedFlow = normalizeFlowPayload(flowData);
    let deferBubbleInsertForPopupForm = false;

    let preservedStaticWelcomeTimestamp = null;

    // Handle welcome message replacement: if static welcome is shown and this is a real welcome message,
    // REPLACE the static welcome with the real one (which has a real server message ID)
    if (
      staticWelcomeShown &&
      type === "agent" &&
      normalizedText &&
      isWelcomeMessage(normalizedText) &&
      messageId &&
      !messageId.startsWith("static_welcome_") // Only replace if this is a REAL message ID
    ) {
      // Find and remove the static welcome message
      const staticWelcome = Array.from(messages.values()).find(
        (msg) => msg.id && msg.id.startsWith("static_welcome_"),
      );
      if (staticWelcome) {
        const staticTsFromData = new Date(staticWelcome.timestamp).getTime();
        const staticTsFromDom = staticWelcome.element
          ? Number.parseInt(
              staticWelcome.element.getAttribute("data-timestamp") || "",
              10,
            )
          : NaN;
        preservedStaticWelcomeTimestamp = Number.isFinite(staticTsFromData)
          ? staticTsFromData
          : Number.isFinite(staticTsFromDom)
            ? staticTsFromDom
            : null;
        if (staticWelcome.element) {
          staticWelcome.element.remove();
        }
        messages.delete(staticWelcome.id);
        // Save the real welcome message ID for read receipts
        realWelcomeMessageId = messageId;
        console.log(
          "UniBox: Replaced static welcome with real welcome message ID:",
          messageId,
        );
      }
      staticWelcomeShown = false;
      // Continue to add the real welcome message below
    }

    const normalizedId = messageId || `msg_${Date.now()}`;
    const incomingTimestamp = timestamp ? new Date(timestamp).getTime() : NaN;
    const normalizedTimestamp = Number.isFinite(preservedStaticWelcomeTimestamp)
      ? preservedStaticWelcomeTimestamp
      : Number.isFinite(incomingTimestamp)
        ? incomingTimestamp
        : Date.now();

    // Debug: Log message being added
    console.log("UniBox: appendMessageToUI called:", {
      id: normalizedId,
      text: normalizedText?.substring(0, 30),
      sender: type,
      timestamp: normalizedTimestamp,
      timestampDate: new Date(normalizedTimestamp).toISOString(),
    });

    // --- FIX: Robust Deduplication Logic ---
    const existingInMap =
      messages.get(normalizedId) ||
      Array.from(messages.values()).find((m) => {
        // 1. Exact ID Match
        if (m.id === normalizedId || m.messageId === normalizedId) return true;

        // 2. Media Match
        if (mediaStorageUrl && m.mediaStorageUrl === mediaStorageUrl) {
          return (
            Math.abs(new Date(m.timestamp).getTime() - normalizedTimestamp) <
            10000
          );
        }

        // 3. Text + Timestamp Fuzzy Match (Fixes ghosting)
        // Check if text matches, sender matches, and time is within 30 seconds
        if (normalizedText && m.text === normalizedText && m.sender === type) {
          const timeDiff = Math.abs(
            new Date(m.timestamp).getTime() - normalizedTimestamp,
          );
          if (timeDiff < 30000) {
            // If we found a match by text, update the ID map so future lookups find it by ID
            if (messageId && m.id !== messageId) {
              // Update internal tracking object to use the real Server ID
              const oldId = m.id;

              // Update map
              messages.delete(oldId);
              m.id = messageId;
              m.messageId = messageId;
              m.status = status || m.status;
              m.timestamp = timestamp || m.timestamp; // Update timestamp to server's timestamp
              messages.set(messageId, m);

              // Update DOM attributes for proper sorting
              if (m.element) {
                m.element.setAttribute("data-message-id", messageId);
                // CRITICAL: Update data-timestamp to server's timestamp for correct sorting
                m.element.setAttribute(
                  "data-timestamp",
                  normalizedTimestamp.toString(),
                );
              }
            }
            return true;
          }
        }
        return false;
      });

    if (existingInMap && existingInMap.element) {
      existingInMap.status = status || existingInMap.status;
      existingInMap.readAt = readAt || existingInMap.readAt;
      existingInMap.readByUs =
        readByUs !== undefined ? readByUs : existingInMap.readByUs;
      existingInMap.readByUsAt = readByUsAt || existingInMap.readByUsAt;

      // CRITICAL: Update timestamp if server provided one (for correct sorting)
      if (timestamp && existingInMap.element) {
        existingInMap.timestamp = timestamp;
        existingInMap.element.setAttribute(
          "data-timestamp",
          normalizedTimestamp.toString(),
        );
      }
      return;
    }

    const existingInDOM = Array.from(body.children).find((child) => {
      const childId = child.getAttribute("data-message-id");
      if (childId === normalizedId) return true;
      return false;
    });

    if (existingInDOM) {
      if (normalizedId && !messages.has(normalizedId)) {
        messages.set(normalizedId, {
          id: normalizedId,
          messageId: normalizedId,
          text: normalizedText,
          sender: type,
          agentName: type === "agent" ? liveAgentDisplayName || null : null,
          agentId: type === "agent" ? liveAgentId || null : null,
          timestamp: timestamp || new Date(),
          status: status || "sent",
          readAt,
          readByUs: readByUs || false,
          readByUsAt,
          type: messageType,
          mediaStorageUrl: mediaStorageUrl,
          element: existingInDOM,
        });
      }
      return;
    }

    const isIncomingAgentMessage =
      type === "agent" &&
      !String(normalizedId).startsWith("static_welcome_") &&
      !String(normalizedId).startsWith("temp_");
    if (isIncomingAgentMessage) {
      const msgAgeMs = Math.abs(Date.now() - normalizedTimestamp);
      const hostRoot = document.getElementById("unibox-root");
      const chatWindowEl = hostRoot?.shadowRoot?.getElementById("chatWindow");
      const isOpen = Boolean(chatWindowEl?.classList.contains("open"));
      if (!isOpen && msgAgeMs <= 15000) {
        setLauncherEventBadgeVisible(true);
      }
      const soundCfg = getSoundNotificationConfig();
      if (soundCfg.newMessageSoundEnabled && !isOpen) {
        playSystemSound(soundCfg.soundType);
      }
      if (msgAgeMs <= 15000) {
        maybeNotifyIncomingMessage(
          bubbleAgentLabel,
          normalizedText || "",
        );
      }
    }

    // CREATE MESSAGE ELEMENTS WITH NEW CLASSES
    const msgDiv = document.createElement("div");
    msgDiv.className = `chat-widget-message ${
      type === "agent" ? "bot" : "user"
    }`;
    msgDiv.setAttribute("data-message-id", normalizedId);
    msgDiv.setAttribute("data-timestamp", normalizedTimestamp.toString());

    if (type === "agent") {
      const topRow = document.createElement("div");
      topRow.className = "chat-widget-message-bot-top";
      if (resolvedAvatarUrl) {
        const av = document.createElement("img");
        av.className = "chat-widget-message-avatar";
        av.src = resolvedAvatarUrl;
        av.alt = "";
        av.setAttribute("aria-hidden", "true");
        topRow.appendChild(av);
      }
      const labelEl = document.createElement("div");
      labelEl.className = "chat-widget-message-label";
      labelEl.textContent = bubbleAgentLabel;
      topRow.appendChild(labelEl);
      msgDiv.appendChild(topRow);
    }

    const msgContent = document.createElement("div");
    msgContent.className = "chat-widget-message-content";

    // Handle media messages - show as chips/buttons instead of loading directly
    // Check if this is a media message (has type and media_storage_url)
    const isMediaMessage =
      messageType &&
      ["image", "video", "audio", "document", "file"].includes(messageType);
    const hasMedia =
      isMediaMessage && mediaStorageUrl && mediaStorageUrl.trim() !== "";

    // Ensure media messages are always rendered, even with empty/null text
    if (hasMedia) {
      const mediaMeta = getMediaChipMeta(
        messageType,
        mediaStorageUrl,
        normalizedText,
      );

      // Always show media as a clickable chip (same as agent side)
      const mediaChip = document.createElement("button");
      mediaChip.className = "chat-widget-media-chip";
      mediaChip.type = "button";
      mediaChip.onclick = () => {
        showMediaPreview(mediaStorageUrl, messageType, normalizedText);
      };

      const iconImg = document.createElement("img");
      iconImg.src = mediaMeta.icon;
      iconImg.alt = "File";
      iconImg.width = 20;
      iconImg.height = 20;
      iconImg.className = "chat-widget-media-chip-icon";

      const labelSpan = document.createElement("span");
      labelSpan.className = "chat-widget-media-chip-label";
      labelSpan.textContent = mediaMeta.label;

      mediaChip.appendChild(iconImg);
      mediaChip.appendChild(labelSpan);
      msgContent.appendChild(mediaChip);

      // Add text caption if available and not the file name
      if (
        normalizedText &&
        normalizedText !== "Uploading..." &&
        !normalizedText.includes("Uploading") &&
        normalizedText !== mediaMeta.label
      ) {
        const captionDiv = document.createElement("div");
        captionDiv.className = "chat-widget-media-caption";
        captionDiv.textContent = normalizedText;
        captionDiv.style.marginTop = "8px";
        captionDiv.style.fontSize = "14px";
        captionDiv.style.lineHeight = "1.5";
        captionDiv.style.color = "#18181e";
        msgContent.appendChild(captionDiv);
      }

      // Store message data with media info
      if (normalizedId) {
        const messageData = {
          id: normalizedId,
          messageId: normalizedId,
          text: normalizedText,
          sender: type,
          agentName: type === "agent" ? liveAgentDisplayName || null : null,
          agentId: type === "agent" ? liveAgentId || null : null,
          timestamp: timestamp || new Date(),
          status: status || "sent",
          readAt,
          readByUs: readByUs || false,
          readByUsAt,
          type: messageType,
          mediaStorageUrl: mediaStorageUrl,
          flow: normalizedFlow,
          element: msgDiv,
        };
        messages.set(normalizedId, messageData);
      }

      msgDiv.appendChild(msgContent);

      // Insert message BEFORE typing indicator (so indicator stays at the end)
      const typingIndicator = body.querySelector("#typingIndicator");
      if (typingIndicator) {
        body.insertBefore(msgDiv, typingIndicator);
      } else {
        body.appendChild(msgDiv);
      }

      requestAnimationFrame(() => {
        body.scrollTop = body.scrollHeight;
      });
      return; // Don't continue with text message logic
    }

    // Handle text messages (non-media)
    if (!hasMedia) {
      // Only set text content if we have text (don't set empty string for null)
      if (normalizedText) {
        msgContent.textContent = normalizedText;
      } else {
        // No text — only keep going if the flow payload has renderable content
        // (options buttons, dropdown choices, or a question/form prompt).
        const hasFlowContent =
          normalizedFlow &&
          (normalizedFlow.options?.length > 0 ||
            normalizedFlow.dropdownOptions?.length > 0 ||
            (normalizedFlow.form &&
              normalizedFlow.form.mode === "popup" &&
              Array.isArray(normalizedFlow.form.fields) &&
              normalizedFlow.form.fields.length > 0) ||
            normalizedFlow.inputType ||
            normalizedFlow.isEnd);
        if (!hasFlowContent) {
          return; // Truly empty — skip rendering
        }
      }
    }

    // ── Quick-option buttons (options node) ──────────────────────────────────
    let optionsWrap = null;
    if (
      type === "agent" &&
      allowFlowChoiceUi &&
      normalizedFlow &&
      Array.isArray(normalizedFlow.options) &&
      normalizedFlow.options.length > 0
    ) {
      optionsWrap = document.createElement("div");
      optionsWrap.className = "chat-widget-flow-options";
      normalizedFlow.options.forEach((opt) => {
        const label = opt.title || opt.id || "";
        if (!label) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chat-widget-flow-option-btn";
        btn.textContent = label;
        btn.onclick = () => {
          // Hide the entire options wrap after a selection — keeping the
          // disabled buttons visible is confusing once the user has picked
          // one (and is explicitly called out as bad UX on the widget).
          if (optionsWrap && optionsWrap.parentNode) {
            optionsWrap.parentNode.removeChild(optionsWrap);
          }
          const outgoingText = opt.title || opt.id || "";
          if (!outgoingText) return;
          const localMessageId = `msg_${Date.now()}_${Math.random()
            .toString(36)
            .substr(2, 9)}`;
          appendMessageToUI(
            outgoingText,
            "user",
            localMessageId,
            new Date(),
            "sent",
            null,
            false,
            null,
            "text",
            null,
          );
          // Send value (workflow interactivePayload) + legacy interactive fields
          const optionValue = opt.value || opt.id || outgoingText;
          sendMessageToApi(outgoingText, {
            interactivePayload: { value: optionValue },
            interactive: {
              button_reply: { id: optionValue, title: outgoingText },
            },
          }).catch((err) => {
            console.error("UniBox: Failed to send flow option", err);
          });
        };
        optionsWrap.appendChild(btn);
      });
      if (!optionsWrap.childElementCount) {
        optionsWrap = null;
      }
    }

    // ── Dropdown option buttons (question node with inputType:"dropdown") ────
    let dropdownWrap = null;
    if (
      type === "agent" &&
      allowFlowChoiceUi &&
      normalizedFlow &&
      normalizedFlow.inputType === "dropdown" &&
      Array.isArray(normalizedFlow.dropdownOptions) &&
      normalizedFlow.dropdownOptions.length > 0
    ) {
      dropdownWrap = document.createElement("div");
      dropdownWrap.className = "chat-widget-flow-options";
      normalizedFlow.dropdownOptions.forEach((optValue) => {
        if (!optValue) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chat-widget-flow-option-btn";
        btn.textContent = String(optValue);
        btn.onclick = () => {
          // Hide the dropdown options after the user picks one; keeping them
          // around (disabled) is visually noisy and matches the quick-options
          // behaviour above.
          if (dropdownWrap && dropdownWrap.parentNode) {
            dropdownWrap.parentNode.removeChild(dropdownWrap);
          }
          const selected = String(optValue);
          const localMessageId = `msg_${Date.now()}_${Math.random()
            .toString(36)
            .substr(2, 9)}`;
          appendMessageToUI(
            selected,
            "user",
            localMessageId,
            new Date(),
            "sent",
            null,
            false,
            null,
            "text",
            null,
          );
          sendMessageToApi(selected, {
            interactivePayload: { value: selected },
          }).catch((err) => {
            console.error("UniBox: Failed to send dropdown selection", err);
          });
        };
        dropdownWrap.appendChild(btn);
      });
      if (!dropdownWrap.childElementCount) dropdownWrap = null;
    }

    // ── Popup form (form node with formMode:"popup") ────────────────────────
    if (type === "agent") {
      const popupFormConfig = extractPopupFormConfig(normalizedFlow);
      if (popupFormConfig) {
        const threadBubbleText =
          normalizedText ||
          (typeof popupFormConfig.formTitle === "string" &&
          popupFormConfig.formTitle.trim()
            ? popupFormConfig.formTitle.trim()
            : "Form");
        msgContent.textContent = threadBubbleText;
        if (allowPopupFormActivation) {
          activePopupFormConfig = popupFormConfig;
          popupFormValues = {};
          popupFormError = "";
          isSubmittingPopupForm = false;
          // Keep the form title as a thread bubble, but defer inserting it while
          // popup form view is active.
          currentView = "popup-form";
          deferBubbleInsertForPopupForm = true;
          renderView();
        }
      }
    }

    // Only append if we have content (text or media or flow UI)
    const hasFlowUI = !!(optionsWrap || dropdownWrap);
    if (!hasMedia && !normalizedText && !hasFlowUI && !deferBubbleInsertForPopupForm) {
      return; // Safety check - don't render empty messages
    }

    msgDiv.appendChild(msgContent);
    if (optionsWrap) {
      msgDiv.appendChild(optionsWrap);
    }
    if (dropdownWrap) {
      msgDiv.appendChild(dropdownWrap);
    }

    const msgMeta = document.createElement("div");
    msgMeta.className = "chat-widget-message-meta";
    if (type === "user") {
      msgMeta.insertAdjacentHTML(
        "beforeend",
        getReadReceiptIcon(status, readAt, readByUs, readByUsAt, type),
      );
    }
    const timeEl = document.createElement("span");
    timeEl.className = "chat-widget-message-time";
    timeEl.textContent = formatTimestamp(normalizedTimestamp, true);
    msgMeta.appendChild(timeEl);
    msgContent.appendChild(msgMeta);

    // Store message data (for text messages only - media messages are stored above)
    if (!hasMedia && normalizedId) {
      const messageData = {
        id: normalizedId,
        messageId: normalizedId,
        text: normalizedText,
        sender: type,
        agentName: type === "agent" ? liveAgentDisplayName || null : null,
        agentId: type === "agent" ? liveAgentId || null : null,
        timestamp: timestamp || new Date(),
        status: status || "sent",
        readAt,
        readByUs: readByUs || false,
        readByUsAt,
        type: messageType,
        mediaStorageUrl: mediaStorageUrl,
        flow: normalizedFlow,
        element: msgDiv,
      };
      messages.set(normalizedId, messageData);
      if (messageId && normalizedId !== messageId) {
        messages.set(messageId, messageData);
      }
    }

    // Insert message BEFORE typing indicator (so indicator stays at the end).
    // For popup forms, keep this bubble in thread state and insert it later
    // when chat view is shown again.
    if (!deferBubbleInsertForPopupForm) {
      const typingIndicator = body.querySelector("#typingIndicator");
      if (typingIndicator) {
        body.insertBefore(msgDiv, typingIndicator);
      } else {
        body.appendChild(msgDiv);
      }
    }

    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });

    if (waitingForFirstInboundMessage && isRealInboundBotMessage(type, normalizedId)) {
      waitingForFirstInboundMessage = false;
      setInitialBodyLoading(false);
    }

    // Apply workflow-driven input state changes (disable on end, hint on question)
    if (type === "agent" && normalizedFlow) {
      applyFlowState(normalizedFlow);
    }
  }

  function sortMessagesByTimestamp() {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById("chatBody");
    if (!body) return;
    const chatWindowEl = host.shadowRoot.getElementById("chatWindow");
    const isOpen = Boolean(chatWindowEl?.classList.contains("open"));
    if (!isOpen) {
      setLauncherEventBadgeVisible(true);
    }

    const messageElements = Array.from(body.children).filter((child) => {
      return child.hasAttribute("data-timestamp");
    });

    // Debug: Log timestamps before sorting
    if (messageElements.length > 0) {
      console.log(
        "UniBox: Sorting messages by timestamp:",
        messageElements.map((el) => ({
          id: el.getAttribute("data-message-id"),
          timestamp: el.getAttribute("data-timestamp"),
          text: el
            .querySelector(".chat-widget-message-content")
            ?.textContent?.substring(0, 30),
        })),
      );
    }

    messageElements.sort((a, b) => {
      const timestampA = parseInt(a.getAttribute("data-timestamp") || "0");
      const timestampB = parseInt(b.getAttribute("data-timestamp") || "0");
      return timestampA - timestampB;
    });

    // Get typing indicator to keep it at the end
    const typingIndicator = body.querySelector("#typingIndicator");

    // Re-append messages in sorted order BEFORE typing indicator
    messageElements.forEach((element) => {
      if (typingIndicator) {
        body.insertBefore(element, typingIndicator);
      } else {
        body.appendChild(element);
      }
    });

    // Ensure typing indicator is always last
    if (typingIndicator) {
      body.appendChild(typingIndicator);
    }

    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });
  }

  function updateReadReceipt(receipt) {
    return;
  }

  /**
   * Mark messages as read - User MUST send read receipts to agent
   * User does NOT receive read receipts from agent
   * ALL status updates go via WebSocket only - no HTTP API calls
   */
  function markMessagesAsRead(messageIds) {
    const advanced = getAdvancedSettingsConfig();
    if (!advanced.visitorTrackingEnabled) return;
    if (!conversationId || !userId || settings.testMode) return;
    if (!messageIds || messageIds.length === 0) return;

    // Filter out client-side generated IDs (not real server message IDs)
    // Real message IDs are UUIDs, not prefixed strings
    const validMessageIds = messageIds.filter((id) => {
      if (!id || typeof id !== "string") return false;
      // Exclude client-side generated IDs
      if (id.startsWith("static_welcome_")) return false;
      if (id.startsWith("proactive_")) return false; // client-only proactive messages
      if (id.startsWith("msg_")) return false; // client-generated optimistic IDs
      if (id.startsWith("guest_")) return false;
      if (id.startsWith("user_")) return false;
      if (id.startsWith("temp_")) return false;
      if (id.startsWith("optimistic_")) return false;
      return true;
    });

    if (validMessageIds.length === 0) {
      console.log("UniBox: No valid message IDs to mark as read");
      return;
    }

    // Send read receipt via WebSocket ONLY
    const sent = wsSend({
      action: "read",
      conversationId: conversationId,
      messageIds: validMessageIds,
    });

    if (sent) {
      console.log(
        "UniBox: Read receipt sent via WebSocket for",
        validMessageIds.length,
        "messages",
      );
    } else {
      console.log("UniBox: Read receipt queued (WebSocket not ready)");
    }
  }

  function markVisibleMessagesAsRead() {
    const advanced = getAdvancedSettingsConfig();
    if (!advanced.visitorTrackingEnabled) return;
    if (!conversationId || !userId || settings.testMode) return;
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById("chatBody");
    if (!body) return;

    const unreadAgentMessages = Array.from(messages.values())
      .filter((msg) => {
        return msg.sender === "agent" && (msg.status !== "read" || !msg.readAt);
      })
      .map((msg) => msg.id || msg.messageId)
      .filter((id) => {
        // Filter out null/undefined IDs and client-side static welcome message IDs
        if (!id) return false;
        if (typeof id === "string" && id.startsWith("static_welcome_"))
          return false;
        return true;
      });

    if (unreadAgentMessages.length > 0) {
      markMessagesAsRead(unreadAgentMessages);
    }
  }

  function updateOnlineStatus(isOnline, isAgentSide) {
    if (isAgentSide) {
      isAgentOnline = !!isOnline;
      refreshHeaderPresence();
    }
  }

  function refreshHeaderPresence() {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const headerOnlineDot = host.shadowRoot.getElementById("headerOnlineDot");
    if (!headerOnlineDot) return;

    const windowEl = host.shadowRoot.getElementById("chatWindow");
    const chatOpen = windowEl?.classList.contains("open");
    const wsLive = socket && socket.readyState === WebSocket.OPEN;

    if (!liveAgentDisplayName) {
      headerOnlineDot.className = "chat-widget-online-dot hidden";
      return;
    }

    let dotClass = "offline";
    if (liveAgentDisplayName) {
      dotClass = isAgentOnline ? "online" : "offline";
    } else if (chatOpen && !wsLive) {
      dotClass = "connecting";
    }
    headerOnlineDot.className = `chat-widget-online-dot ${dotClass}`;
  }

  function showTypingIndicator(show, options) {
    if (show && !settings?.behavior?.typingIndicator && !options?.force) return;
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const typingIndicator = host.shadowRoot.getElementById("typingIndicator");
    if (!typingIndicator) return;
    if (show) {
      const kind = options?.kind === "agent" ? "agent" : "ai";
      typingIndicator.classList.remove("hidden");
      typingIndicator.setAttribute("data-typing-kind", kind);
      const body = host.shadowRoot.getElementById("chatBody");
      if (body) {
        requestAnimationFrame(() => {
          body.scrollTop = body.scrollHeight;
        });
      }
    } else {
      typingIndicator.classList.add("hidden");
      typingIndicator.removeAttribute("data-typing-kind");
    }
  }

  /**
   * Emit typing status to agent via WebSocket
   * User MUST send typing indicators to agent
   */
  function emitTypingStatus(typing) {
    if (!conversationId || !userId) return;

    wsSend({
      action: "typing",
      conversationId: conversationId,
      userId,
      isTyping: typing,
    });
  }

  function escapeHtmlWidget(t) {
    return String(t)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // --- 10. UI RENDERING ---
  function renderWidget() {
    removeWidgetRoot();
    const host = document.createElement("div");
    host.id = "unibox-root";
    host.setAttribute("data-unibox-instance", INSTANCE_KEY);
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    // Header / open launcher: primary → secondary only (legacy gradientColor3 no longer used here)
    const c1 =
      settings.appearance.gradientColor1 ||
      settings.appearance.primaryColor ||
      "#912FF5";
    const c2 =
      settings.appearance.gradientColor2 ||
      settings.appearance.secondaryColor ||
      "#EF32D4";
    const rawC3 = settings.appearance.gradientColor3 || "#7DBCFE";
    const c3Hex = String(rawC3).trim().replace(/^#/, "").toLowerCase();
    const c3 =
      c3Hex === "fff" ||
      c3Hex === "ffffff" ||
      c3Hex === "ffff" ||
      String(rawC3).trim().toLowerCase() === "white"
        ? "#7DBCFE"
        : rawC3;
    const pulseRingGradientCss = `conic-gradient(
      from var(--pulse-angle, 0deg),
      #7DBCFE 0%,
      #912FF5 35%,
      #EF32D4 50%,
      #912FF5 65%,
      #7DBCFE 100%
    )`;
    const preview = settings.preview || {};
    const primaryColor =
      preview.primaryColor || settings.appearance.primaryColor || c1;
    const secondaryColor =
      preview.secondaryColor || settings.appearance.secondaryColor || c2;
    const chromeGradientCss = `linear-gradient(272.16deg, ${primaryColor} 0.45%, ${secondaryColor} 99.8%)`;
    const accentColor = primaryColor;
    const launcherBg = primaryColor;
    const poweredByBrandGradientCss =
      "linear-gradient(272.16deg, #EF32D4 0.45%, #912FF5 45.12%, #7DBCFE 99.8%)";

    const placement = settings.behavior.stickyPlacement || "bottom-right";
    const isTop = placement.includes("top");
    const isRight = placement.includes("right");
    const bubbleAnimation =
      preview.bubbleAnimation ?? settings.appearance.bubbleAnimation ?? "none";
    const launcherAnimClass =
      bubbleAnimation === "bounce"
        ? "chat-widget-launcher-bounce"
        : bubbleAnimation === "pulse"
          ? "chat-widget-launcher-pulse"
          : "";

    const bubbleSizeMap = { small: 48, medium: 60, large: 64 };
    const launcherPaddingMap = { small: 6, medium: 8, large: 10 };
    const textLauncherSizeMap = {
      small: {
        minHeight: 40,
        icon: 18,
        gap: 6,
        fontSize: 13,
        lineHeight: 18,
        maxWidth: 170,
      },
      medium: {
        minHeight: 44,
        icon: 20,
        gap: 8,
        fontSize: 14,
        lineHeight: 20,
        maxWidth: 210,
      },
      large: {
        minHeight: 48,
        icon: 22,
        gap: 10,
        fontSize: 15,
        lineHeight: 22,
        maxWidth: 250,
      },
    };
    const launcherFacePx =
      bubbleSizeMap[
        preview.bubbleSize || settings.appearance.bubbleSize || "small"
      ] || bubbleSizeMap.small;
    const launcherPaddingPx =
      launcherPaddingMap[
        preview.bubbleSize || settings.appearance.bubbleSize || "small"
      ] || launcherPaddingMap.small;
    const textLauncherSize =
      textLauncherSizeMap[
        preview.bubbleSize || settings.appearance.bubbleSize || "small"
      ] || textLauncherSizeMap.small;
    const textLauncherIconSizePx = Math.max(
      16,
      textLauncherSize.minHeight - 2 * launcherPaddingPx,
    );
    const pulseRingStrokePx = 2;
    const pulseRingGapPx = 1;
    const pulseRingInsetPx = pulseRingStrokePx + pulseRingGapPx;
    const launcherOuterPulsePx = launcherFacePx + 2 * pulseRingInsetPx;
    const launcherLayoutPx =
      bubbleAnimation === "pulse" ? launcherOuterPulsePx : launcherFacePx;
    const windowLauncherGapPx = 8;
    const marginH = Math.max(0, Number(preview.rightMarginPx ?? 20));
    const marginV = Math.max(0, Number(preview.bottomMarginPx ?? 20));
    const horizontalLauncherCss = isRight
      ? `right: ${marginH}px;`
      : `left: ${marginH}px;`;
    const horizontalWindowCss = isRight
      ? `right: ${marginH}px;`
      : `left: ${marginH}px;`;
    const verticalLauncherCss = isTop
      ? `top: ${marginV}px;`
      : `bottom: ${marginV}px;`;
    const verticalWindowCss = isTop
      ? `top: ${marginV + launcherLayoutPx + windowLauncherGapPx}px;`
      : `bottom: ${marginV + launcherLayoutPx + windowLauncherGapPx}px;`;

    resolvedFontFamily = resolveWidgetFont(
      settings.appearance.fontFamily,
    );

    const fontSizeMap = {
      small: { body: "14px", meta: "12px", input: "14px", title: "16px" },
      medium: { body: "15px", meta: "13px", input: "15px", title: "17px" },
      large: { body: "16px", meta: "14px", input: "16px", title: "18px" },
    };
    const fontSizes =
      fontSizeMap[preview.fontSize || "small"] || fontSizeMap.small;

    const windowSizeMap = {
      compact: { width: 340, height: 460 },
      medium: { width: 360, height: 500 },
      large: { width: 400, height: 560 },
    };
    const windowSize =
      windowSizeMap[preview.windowSize || "medium"] || windowSizeMap.medium;
    const radiusByStyle = { rounded: "10px", minimal: "0px", card: "16px" };
    const windowRadius =
      radiusByStyle[preview.windowStyle || "rounded"] || radiusByStyle.rounded;

    const chatBubbleColor = preview.chatBubbleColor || "#ECE1FF";
    const agentMessageColor = preview.agentMessageColor || "#F5F5F5";
    const backgroundColor = preview.backgroundColor || "#FFFFFF";
    const bodyHeaderOverlap = 36;

    const hasCustomZ =
      Object.prototype.hasOwnProperty.call(preview, "zIndex") &&
      preview.zIndex !== null &&
      preview.zIndex !== "";
    const zLauncher = hasCustomZ ? Number(preview.zIndex) : 2147483647;
    const zWindow = hasCustomZ ? Number(preview.zIndex) + 1 : 2147483647;

    const subtitle = String(preview.subtitle || "").trim();

    const styleTag = document.createElement("style");

    const getMessageMapFromDemoFlow = (flow) => {
      if (!flow || !Array.isArray(flow.messages)) return new Map();
      return new Map(flow.messages.map((m) => [String(m.id || ""), m]));
    };
    const getQuickActionMapFromDemoFlow = (flow) => {
      if (!flow || !Array.isArray(flow.quickActions)) return new Map();
      return new Map(flow.quickActions.map((q) => [String(q.id || ""), q]));
    };

    // Updated CSS to match the provided JSX UI exactly
    styleTag.textContent = `
        :host {
          font-family: ${resolvedFontFamily} !important;
        }
        
        /* Note: Container set to fixed to ensure it floats above page content as a widget */
        .chat-widget-container {
          position: fixed; z-index: 2147483647; 
          top: auto; bottom: auto; left: auto; right: auto;
          width: 0; height: 0;
          font-family: ${resolvedFontFamily};
          display: block;
        }

        .chat-widget-container *,
        .chat-widget-header,
        .chat-widget-header *,
        .chat-widget-messages-pane,
        .chat-widget-messages-pane *,
        .chat-widget-scroll-wrap,
        .chat-widget-scroll-wrap *,
        .chat-widget-body,
        .chat-widget-body *,
        .chat-widget-footer,
        .chat-widget-footer *,
        .chat-widget-input,
        .chat-widget-form-input,
        .chat-widget-form-btn {
          font-family: ${resolvedFontFamily} !important;
          box-sizing: border-box;
        }

        .chat-widget-launcher {
          position: fixed; ${verticalLauncherCss} ${horizontalLauncherCss}
          width: ${launcherFacePx}px;
          height: ${launcherFacePx}px;
          padding: 0;
          background: transparent;
          border-radius: 50%;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.15);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.2s, width 0.2s, height 0.2s;
          overflow: visible;
          z-index: ${zLauncher};
        }
        .chat-widget-launcher-badge {
          position: absolute;
          top: -2px;
          right: -2px;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #ff3b30;
          border: 2px solid transparent;
          z-index: 3;
          pointer-events: none;
        }
        .chat-widget-launcher-badge.hidden {
          display: none !important;
        }
        .chat-widget-launcher.open .chat-widget-launcher-badge {
          display: none !important;
        }
        .chat-widget-launcher.chat-widget-launcher-floating {
          border-radius: 8px;
        }
        .chat-widget-launcher.chat-widget-launcher-custom {
          border-radius: 4px;
        }
        .chat-widget-launcher.chat-widget-launcher-text {
          width: auto;
          min-width: fit-content;
          max-width: ${textLauncherSize.maxWidth}px;
          min-height: ${textLauncherSize.minHeight}px;
          height: auto;
          border-radius: 8px;
          padding: ${launcherPaddingPx}px;
          background: ${launcherBg};
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
        }
        .chat-widget-launcher.chat-widget-launcher-floating .chat-widget-launcher-inner {
          border-radius: 8px;
        }
        .chat-widget-launcher.chat-widget-launcher-custom .chat-widget-launcher-inner {
          border-radius: 4px;
        }
        .chat-widget-launcher-floating .chat-widget-launcher-pulse-ring {
          border-radius: 10px;
        }
        .chat-widget-launcher-custom .chat-widget-launcher-pulse-ring {
          border-radius: 4px;
        }
        .chat-widget-launcher.chat-widget-launcher-pulse:not(.open) {
          width: ${launcherOuterPulsePx}px;
          height: ${launcherOuterPulsePx}px;
        }
        .chat-widget-launcher.chat-widget-launcher-floating.chat-widget-launcher-pulse:not(.open),
        .chat-widget-launcher.chat-widget-launcher-text.chat-widget-launcher-pulse:not(.open) {
          border-radius: 10px;
        }
        .chat-widget-launcher.chat-widget-launcher-custom.chat-widget-launcher-pulse:not(.open) {
          border-radius: ${4 + pulseRingInsetPx}px;
        }
        .chat-widget-launcher.chat-widget-launcher-text.chat-widget-launcher-pulse:not(.open) {
          width: auto;
          height: auto;
          padding: ${pulseRingInsetPx}px;
          background: transparent;
        }
        .chat-widget-launcher-pulse-ring {
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background: ${pulseRingGradientCss};
          padding: ${pulseRingStrokePx}px;
          -webkit-mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          animation: launcherPulseRingRotate 4s linear infinite;
          z-index: 0;
          pointer-events: none;
        }
        .chat-widget-launcher.open .chat-widget-launcher-pulse-ring {
          display: none;
        }
        .chat-widget-launcher-inner {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background: ${launcherBg};
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          z-index: 2;
          padding: ${launcherPaddingPx}px;
        }
        .chat-widget-launcher.chat-widget-launcher-text
          .chat-widget-launcher-inner {
          position: static;
          inset: auto;
          width: auto;
          max-width: ${textLauncherSize.maxWidth}px;
          height: 100%;
          border-radius: 8px;
          padding: 8px 16px;
          gap: ${textLauncherSize.gap}px;
        }
        .chat-widget-launcher.chat-widget-launcher-pulse:not(.open)
          .chat-widget-launcher-inner {
          inset: ${pulseRingInsetPx}px;
        }
        .chat-widget-launcher-inner svg,
        .chat-widget-launcher-inner img {
          width: 100%;
          height: 100%;
          display: block;
          flex-shrink: 0;
        }
        .chat-widget-launcher-inner .chat-widget-launcher-default-icon {
          width: 124%;
          height: 124%;
          max-width: none;
          max-height: none;
        }
        .chat-widget-launcher-inner > img {
          object-fit: contain;
          width: 108%;
          height: 108%;
          max-width: none;
          max-height: none;
          border-radius: 50%;
        }
        .chat-widget-launcher.chat-widget-launcher-text .chat-widget-launcher-inner svg,
        .chat-widget-launcher.chat-widget-launcher-text .chat-widget-launcher-inner img {
          width: ${textLauncherIconSizePx}px;
          height: ${textLauncherIconSizePx}px;
          flex-shrink: 0;
        }
        .chat-widget-launcher.chat-widget-launcher-text .chat-widget-launcher-inner > img {
          border-radius: 4px;
          width: ${textLauncherIconSizePx}px;
          height: ${textLauncherIconSizePx}px;
          max-width: ${textLauncherIconSizePx}px;
          max-height: ${textLauncherIconSizePx}px;
          object-fit: contain;
        }
        .chat-widget-launcher.chat-widget-launcher-text .chat-widget-launcher-inner .chat-widget-launcher-default-icon {
          width: ${textLauncherIconSizePx}px;
          height: ${textLauncherIconSizePx}px;
          max-width: ${textLauncherIconSizePx}px;
          max-height: ${textLauncherIconSizePx}px;
        }
        .chat-widget-launcher.chat-widget-launcher-custom .chat-widget-launcher-inner > img {
          border-radius: 4px;
        }
        .chat-widget-launcher-text-label {
          display: block;
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          font-size: ${textLauncherSize.fontSize}px;
          line-height: ${textLauncherSize.lineHeight}px;
          font-weight: 600;
          color: #ffffff;
          white-space: nowrap;
        }
        .chat-widget-launcher-text-hover-tooltip {
          position: absolute;
          bottom: calc(100% + 10px);
          transform: translateY(4px);
          background: #ffffff;
          color: #18181e;
          border-radius: 6px;
          padding: 6px 10px;
          font-size: ${fontSizes.meta};
          line-height: 18px;
          font-weight: 500;
          max-width: min(320px, calc(100vw - 24px));
          white-space: normal;
          box-shadow: 0px 2px 7px 0px #0000001f;
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          z-index: 3;
          transition:
            opacity 0.18s ease,
            transform 0.18s ease,
            visibility 0s linear 0.18s;
        }
        .chat-widget-launcher-text-hover-tooltip.chat-widget-launcher-text-hover-tooltip-left {
          right: 0;
        }
        .chat-widget-launcher-text-hover-tooltip.chat-widget-launcher-text-hover-tooltip-right {
          left: 0;
        }
        .chat-widget-launcher-text-hover-tooltip::after {
          content: "";
          position: absolute;
          bottom: -5px;
          width: 10px;
          height: 10px;
          background: #ffffff;
          transform: rotate(45deg);
        }
        .chat-widget-launcher-text-hover-tooltip.chat-widget-launcher-text-hover-tooltip-left::after {
          right: 18px;
        }
        .chat-widget-launcher-text-hover-tooltip.chat-widget-launcher-text-hover-tooltip-right::after {
          left: 18px;
        }
        .chat-widget-launcher.chat-widget-launcher-text:not(.open):hover .chat-widget-launcher-text-hover-tooltip {
          opacity: 1;
          visibility: visible;
          transform: translateY(0);
          transition-delay: 0.9s;
        }
        .chat-widget-launcher-tooltip {
          position: absolute;
          bottom: 0;
          transform: none;
          background: #ffffff;
          color: #18181e;
          border-radius: 4px;
          padding: 8px 16px;
          font-size: ${fontSizes.body};
          line-height: 20px;
          font-weight: 500;
          width: fit-content;
          max-width: min(320px, calc(100vw - 24px));
          white-space: normal;
          overflow-wrap: break-word;
          word-break: break-word;
          box-shadow: 0px 2px 7px 0px #0000001f;
          pointer-events: none;
          z-index: 2;
        }
        .chat-widget-launcher-tooltip.chat-widget-launcher-tooltip-left {
          right: calc(100% + 12px);
        }
        .chat-widget-launcher-tooltip.chat-widget-launcher-tooltip-right {
          left: calc(100% + 12px);
        }
        .chat-widget-launcher-tooltip::after {
          content: "";
          position: absolute;
          bottom: 10px;
          width: 10px;
          height: 10px;
          background: #ffffff;
          transform: rotate(45deg);
        }
        .chat-widget-launcher-tooltip.chat-widget-launcher-tooltip-left::after {
          right: -5px;
        }
        .chat-widget-launcher-tooltip.chat-widget-launcher-tooltip-right::after {
          left: -5px;
        }
        .chat-widget-launcher.open .chat-widget-launcher-close-icon {
          width: 58%;
          height: 58%;
          min-width: 18px;
          min-height: 18px;
          max-width: 32px;
          max-height: 32px;
        }
        .chat-widget-launcher.open .chat-widget-launcher-tooltip {
          display: none;
        }

        .chat-widget-launcher:hover {
          transform: scale(1.05);
        }
        .chat-widget-launcher.open,
        .chat-widget-launcher.open:hover,
        .chat-widget-launcher.open.chat-widget-launcher-bounce {
          width: ${launcherFacePx}px !important;
          height: ${launcherFacePx}px !important;
          min-width: ${launcherFacePx}px !important;
          min-height: ${launcherFacePx}px !important;
          max-width: ${launcherFacePx}px !important;
          max-height: ${launcherFacePx}px !important;
          padding: 0 !important;
          border-radius: 50% !important;
          animation: none !important;
          transform: none !important;
          transition: none !important;
        }
        .chat-widget-launcher.chat-widget-launcher-text.open {
          min-width: ${launcherFacePx}px !important;
          min-height: ${launcherFacePx}px !important;
        }

        .chat-widget-launcher.open .chat-widget-launcher-inner {
          background: ${primaryColor} !important;
          inset: 0;
          width: 100%;
          height: 100%;
          border-radius: 50% !important;
          transition: none !important;
        }
        .chat-widget-launcher.chat-widget-launcher-text.open .chat-widget-launcher-inner {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
        }
        .chat-widget-launcher-bounce {
          animation: launcherBounce 1.6s infinite;
        }
        @keyframes launcherPulseRingRotate {
          from {
            --pulse-angle: 0deg;
          }
          to {
            --pulse-angle: 360deg;
          }
        }
        @keyframes launcherBounce {
          0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
          40% { transform: translateY(-5px); }
          60% { transform: translateY(-3px); }
        }

        .chat-widget-window {
          position: fixed; ${verticalWindowCss} ${horizontalWindowCss}
          width: ${windowSize.width}px;
          height: min(
            ${windowSize.height}px,
            calc(100vh - ${marginV + 16}px)
          );
          max-width: calc(100vw - ${2 * marginH + 16}px);
          max-height: calc(100vh - ${marginV + 16}px);
          background: #ffffff;
          border-radius: ${windowRadius};
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          opacity: 0;
          pointer-events: none;
          transform: ${
            isTop ? "translateY(-20px)" : "translateY(20px)"
          } scale(0.95);
          transition: all 0.25s ease;
          z-index: ${zWindow};
        }

        .chat-widget-window.open {
          opacity: 1;
          pointer-events: auto;
          transform: translateY(0) scale(1);
        }

        .chat-widget-header {
          background: ${chromeGradientCss};
          padding: 16px;
          min-height: 96px;
          color: #fff;
          display: flex;
        }

        .chat-widget-header-content {
          width: 100%;
          display: flex;
          gap: 8px;
          align-items: center;
          transform: translateY(-${bodyHeaderOverlap / 2}px);
        }

        .chat-widget-header-logo-wrap {
          position: relative;
          width: 32px;
          height: 32px;
          flex-shrink: 0;
        }

        .chat-widget-header-text {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
        }
        .chat-widget-header-close {
          border: none;
          background: transparent;
          color: #ffffff;
          width: 24px;
          height: 24px;
          border-radius: 4px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          flex-shrink: 0;
          margin-left: 8px;
        }
        .chat-widget-header-close:hover {
          background: rgba(255, 255, 255, 0.16);
        }

        .chat-widget-header-logo {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          border: 1px solid #ffffff;
          object-fit: cover;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .chat-widget-header-agent-profile-wrap {
          width: 32px;
          height: 32px;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-left: 8px;
        }

        .chat-widget-header-agent-profile-wrap.hidden {
          display: none;
        }

        .chat-widget-header-agent-profile {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          border: 1px solid #ffffff;
          object-fit: cover;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .chat-widget-header-agent-profile-fallback {
          background: rgba(255, 255, 255, 0.2);
          color: #ffffff;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.4px;
          text-transform: uppercase;
        }

        .chat-widget-online-dot {
          position: absolute;
          right: -1px;
          bottom: -1px;
          width: 9px;
          height: 9px;
          border-radius: 50%;
          border: 2px solid #ffffff;
          background: #9ca3af;
          z-index: 2;
        }

        .chat-widget-online-dot.hidden {
          display: none;
        }

        .chat-widget-online-dot.online {
          background: #22c55e;
        }

        .chat-widget-online-dot.offline,
        .chat-widget-online-dot.away {
          background: #9ca3af;
        }

        .chat-widget-online-dot.connecting {
          background: #f59e0b;
        }

        .chat-widget-header-logo-icon {
          width: 32px;
          height: 32px;
        }

        .chat-widget-header-title {
          font-weight: 600;
          font-size: ${fontSizes.title};
          flex: 1;
        }

        .chat-widget-messages-pane {
          flex: 1;
          min-height: 0;
          position: relative;
          top: -${bodyHeaderOverlap}px;
          margin-bottom: -${bodyHeaderOverlap}px;
          display: flex;
          flex-direction: column;
          background-color: ${backgroundColor};
          border-radius: ${windowRadius} ${windowRadius} 0 0;
          overflow: hidden;
        }

        .chat-widget-scroll-wrap {
          flex: 1;
          min-height: 0;
          position: relative;
          display: flex;
          flex-direction: column;
          isolation: isolate;
        }

        .chat-widget-scroll-wrap:has(.chat-widget-body--chat)::after {
          content: "*AI-generated content may be inaccurate.";
          position: absolute;
          bottom: 8px;
          left: 0;
          right: 0;
          text-align: center;
          font-family: ${resolvedFontFamily} !important;
          font-size: ${fontSizes.meta};
          line-height: 16px;
          letter-spacing: 0;
          font-weight: 400;
          color: #d9d9d9;
          pointer-events: none;
          z-index: 0;
        }

        .chat-widget-scroll-wrap.chat-widget-scroll-wrap--live-agent:has(.chat-widget-body--chat)::after {
          content: none;
        }

        .chat-widget-body {
          flex: 1;
          min-height: 0;
          position: relative;
          overflow-y: auto;
          overflow-x: hidden;
          display: flex;
          flex-direction: column;
          -webkit-overflow-scrolling: touch;
          background-color: ${backgroundColor};
          scrollbar-width: thin;
          scrollbar-color: #efeff9 transparent;
        }

        /* Same as app globals .custom-select-scrollbar (embed uses shadow DOM) */
        .chat-widget-body::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        .chat-widget-body::-webkit-scrollbar-track {
          background: transparent;
        }
        .chat-widget-body::-webkit-scrollbar-thumb {
          background: #efeff9;
          border-radius: 20px;
          border: none;
        }
        .chat-widget-body::-webkit-scrollbar-thumb:hover {
          background: #d1d5db;
        }
        .chat-widget-body::-webkit-scrollbar-corner {
          background: transparent;
        }

        /* Top inset clears header overlap */
        .chat-widget-body--chat {
          padding: 12px 16px 40px;
        }

        .chat-widget-body--form {
          padding: 16px;
        }

        .chat-widget-loader {
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100%;
        }

        .chat-widget-loader-spinner {
          border: 3px solid #f3f3f3;
          border-top: 3px solid ${accentColor};
          border-radius: 50%;
          width: 24px;
          height: 24px;
          animation: spin 1s linear infinite;
        }

        .chat-widget-initial-loader {
          position: absolute;
          inset: 0;
          z-index: 5;
          display: flex;
          flex-direction: column;
          gap: 10px;
          align-items: center;
          justify-content: center;
          background: rgba(255, 255, 255, 0.86);
          pointer-events: none;
        }

        .chat-widget-initial-loader-spinner {
          width: 32px;
          height: 32px;
          border: 3px solid transparent;
          border-bottom: 3px solid #8D53F8;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }

        .chat-widget-message {
          position: relative;
          z-index: 1;
          max-width: 80%;
          margin-bottom: 16px;
          display: flex;
          flex-direction: column;
          align-items: flex-start; /* let width shrink to content */
        }

        .chat-widget-message.bot {
          align-self: flex-start;
        }

        .chat-widget-message.user {
          align-self: flex-end;
          margin-left: auto; /* push user messages to the right */
          align-items: flex-end;
        }

        .chat-widget-message-content {
          display: inline-block;
          padding: 6px 10px;
          max-width: 100%;
        }

        .chat-widget-message.bot .chat-widget-message-content {
          background: ${agentMessageColor};
          color: #18181e;
          font-family: ${resolvedFontFamily} !important;
          font-size: ${fontSizes.body};
          line-height: 20px;
          letter-spacing: 0;
          font-weight: 400;
          border-radius: 10px;
          border-top-left-radius: 0;
        }

        .chat-widget-message.user .chat-widget-message-content {
          background: ${chatBubbleColor};
          color: #18181e;
          font-family: ${resolvedFontFamily} !important;
          font-size: ${fontSizes.body};
          line-height: 20px;
          letter-spacing: 0;
          font-weight: 400;
          border-radius: 10px;
          border-bottom-right-radius: 0;
        }

        .chat-widget-message-label {
          font-family: ${resolvedFontFamily} !important;
          font-size: ${fontSizes.meta};
          line-height: 16px;
          letter-spacing: 0;
          color: #9da2ab;
          margin-bottom: 8px;
          font-weight: 400;
        }

        .chat-widget-message.bot .chat-widget-message-label {
          align-self: flex-start;
        }

        .chat-widget-message-bot-top {
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }

        .chat-widget-message-avatar {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          object-fit: cover;
          flex-shrink: 0;
        }

        .chat-widget-message.bot .chat-widget-message-bot-top .chat-widget-message-label {
          margin-bottom: 0;
        }

        .chat-widget-message.user .chat-widget-message-label {
          display: none;
        }

        .chat-widget-message-meta {
          display: flex;
          align-items: center;
          gap: 4px;
          margin-top: 2px;
          justify-content: flex-end;
          font-family: ${resolvedFontFamily} !important;
          font-weight: 400;
          font-size: ${fontSizes.meta};
          line-height: 20px;
          letter-spacing: 0;
          text-align: right;
          color: #18181e;
        }

        .chat-widget-message.user .chat-widget-message-meta {
          justify-content: flex-end;
          align-self: flex-end;
        }

        .chat-widget-message.bot .chat-widget-message-meta {
          justify-content: flex-start;
        }

        .chat-widget-message-time {
          color: #18181e;
          font-family: ${resolvedFontFamily} !important;
          font-weight: 400;
          font-size: ${fontSizes.meta};
          line-height: 20px;
          letter-spacing: 0;
          text-align: right;
        }

        .chat-widget-quick-replies {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: -8px;
          margin-bottom: 12px;
          max-width: 80%;
          align-self: flex-start;
          position: relative;
          z-index: 1;
        }
        .chat-widget-quick-reply-btn {
          border: 1px solid #EAEBF2;
          background: #ffffff;
          color: #525261;
          border-radius: 4px;
          padding: 6px 10px;
          font-family: ${resolvedFontFamily} !important;
          font-size: ${fontSizes.meta};
          line-height: 20px;
          font-weight: 400;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .chat-widget-quick-reply-btn:hover {
          background: #f8f3ff;
          border-color: #c9a7ff;
        }
        .chat-widget-flow-options {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 8px;
          margin-bottom: 12px;
          max-width: 100%;
          align-self: stretch;
          position: relative;
          z-index: 1;
        }
        .chat-widget-flow-option-btn {
          border: 1px solid #EAEBF2;
          background: #ffffff;
          color: #525261;
          border-radius: 4px;
          padding: 6px 10px;
          font-family: ${resolvedFontFamily} !important;
          font-size: ${fontSizes.meta};
          line-height: 1.5;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
          text-align: left;
        }
        .chat-widget-flow-option-btn:hover {
          background: #f8f3ff;
          border-color: #c9a7ff;
        }
        .chat-widget-flow-option-btn:disabled {
          opacity: 0.65;
          cursor: default;
        }

        .chat-widget-read-receipt {
          display: inline-flex;
          align-items: center;
        }
        
        .chat-widget-read-receipt-icon {
          display: inline-block;
          vertical-align: middle;
          flex-shrink: 0;
        }

        .chat-widget-typing-indicator {
          position: relative;
          z-index: 6;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 6px;
          padding: 10px 14px 12px;
          background: #f5f5f5;
          border-radius: 12px;
          border-top-left-radius: 0;
          margin: 8px 0;
          max-width: min(280px, 92%);
          align-self: flex-start;
        }

        .chat-widget-typing-indicator.hidden {
          display: none;
        }

        .chat-widget-typing-dots {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .chat-widget-typing-dot {
          width: 6px;
          height: 6px;
          background: #9ca3af;
          border-radius: 9999px;
          transform-origin: center;
          animation: chat-widget-typing-dots 1.15s infinite ease-in-out;
        }

        .chat-widget-typing-dots .chat-widget-typing-dot:nth-child(2) {
          animation-delay: 0.18s;
        }

        .chat-widget-typing-dots .chat-widget-typing-dot:nth-child(3) {
          animation-delay: 0.36s;
        }

        @keyframes chat-widget-typing-dots {
          0%,
          100% {
            transform: scale(1);
            background: #9ca3af;
            opacity: 0.78;
          }
          30% {
            transform: scale(1.33);
            background: #8d53f8;
            opacity: 1;
          }
          60% {
            transform: scale(1.08);
            background: #b5bac4;
            opacity: 0.92;
          }
        }

        .chat-widget-form-container {
          display: flex;
          flex-direction: column;
          gap: 16px;
          background: #ffffff;
          border-radius: 8px;
        }

        .chat-widget-form-input {
          width: 100%;
          padding: 0px 16px;
          height: 32px;
          border: 1px solid #e5e7eb;
          border-radius: 4px;
          font-size: ${fontSizes.body};
        }

        .chat-widget-form-input:focus {
          outline: none;
          border-color: ${accentColor};
        }

        .chat-widget-form-btn {
          width: 100%;
          padding: 0px 16px;
          background: ${accentColor};
          height: 32px;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: ${fontSizes.body};
          font-weight: 400;
          line-height: 20px;
          box-sizing: border-box;
        }

        .chat-widget-footer-section {
          flex-shrink: 0;
          position: relative;
          z-index: 1;
          background: #ffffff;
          border-radius: 0 0 12px 12px;
          box-shadow: 0px -1px 14px 0px #00000014;
        }

        .chat-widget-footer-section.hidden {
          display: none;
        }

        .chat-widget-footer {
          padding: 12px 16px 12px;
          background: #ffffff;
          flex-shrink: 0;
        }

        .chat-widget-footer-row {
          display: flex;
          align-items: center;
          background: #ffffff;
          border: 1px solid #D9D9D9;
          border-radius: 4px;
          padding: 7px 8px;
          gap: 8px;
        }

        #fileChipsContainer {
          display: flex !important;
          flex-wrap: wrap;
          gap: 8px;
          padding: 12px 16px;
          border-bottom: 1px solid #e5e7eb;
          background-color: #ffffff;
        }

        .chat-widget-input-wrapper {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .chat-widget-attach-btn {
          cursor: pointer;
          display: flex;
          border: none;
          padding: 2px;
          width: 24px;
          height: 24px;
          align-items: center;
          justify-content: center;
          background: transparent;
          color: #18181e;
          border-radius: 6px;
          transition: background-color 0.15s ease, opacity 0.15s ease;
        }

        .chat-widget-attach-btn:hover,
        .chat-widget-attach-btn:focus,
        .chat-widget-attach-btn:focus-visible,
        .chat-widget-attach-btn:active {
          background: transparent;
          outline: none;
          box-shadow: none;
        }

        .chat-widget-attach-btn svg {
          width: 18px;
          height: 18px;
        }

        .chat-widget-input {
          flex: 1;
          border: none;
          background: transparent;
          outline: none;
          font-size: ${fontSizes.input};
          color: #1f2937;
        }

        .chat-widget-send-btn {
          cursor: pointer;
          display: flex;
          border: none;
          padding: 0;
          align-items: center;
          justify-content: center;
          background: transparent;
        }

        .chat-widget-send-btn:hover,
        .chat-widget-send-btn:focus,
        .chat-widget-send-btn:focus-visible,
        .chat-widget-send-btn:active {
          background: transparent;
          outline: none;
          box-shadow: none;
        }

        .chat-widget-powered-by {
          display: flex;
          justify-content: center;
          margin-top: 8px;
        }
        .chat-widget-powered-by-row {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          height: 16px;
        }
        .chat-widget-powered-by-trailing {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          height: 16px;
        }
        .chat-widget-powered-by-label,
        .chat-widget-powered-by-brand {
          font-family: ${resolvedFontFamily} !important;
          font-weight: 400;
          font-size: ${fontSizes.body};
          line-height: 16px;
          letter-spacing: 0;
        }
        .chat-widget-powered-by-label {
          color: #d9d9d9;
          text-align: center;
        }
        .chat-widget-powered-by-mark {
          width: 16px;
          height: 16px;
          flex-shrink: 0;
          display: block;
        }
        .chat-widget-powered-by-brand {
          background: ${poweredByBrandGradientCss};
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          -webkit-text-fill-color: transparent;
        }

        .chat-widget-message-content img {
          display: block;
          max-width: 100%;
          height: auto;
        }

        .chat-widget-message-content video {
          display: block;
          max-width: 100%;
          height: auto;
        }

        .chat-widget-message-content audio {
          width: 100%;
          margin-top: 4px;
        }

        .chat-widget-media-image-container {
          display: inline-block;
          max-width: 100%;
        }

        .chat-widget-media-image {
          transition: transform 0.2s, opacity 0.2s;
          opacity: 0;
        }

        .chat-widget-media-image:hover {
          transform: scale(1.02);
        }

        .chat-widget-media-video-container {
          display: inline-block;
          max-width: 100%;
        }

        .chat-widget-media-audio-container {
          width: 100%;
        }

        .chat-widget-media-file-container {
          width: 100%;
          cursor: pointer;
        }

        .chat-widget-media-file-container:hover {
          transform: translateY(-1px);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        .chat-widget-media-caption {
          word-break: break-word;
          white-space: pre-wrap;
        }

        .chat-widget-media-loading {
          animation: fadeIn 0.2s ease-in;
        }

        .chat-widget-media-error {
          animation: fadeIn 0.2s ease-in;
        }

        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        .chat-widget-media-chip {
          display: flex !important;
          align-items: center;
          gap: 8px;
          height: 36px;
          max-width: 100%;
          padding: 0 12px;
          border-radius: 6px;
          border: 1px solid #EFEFEF;
          background: #ffffff;
          cursor: pointer;
          transition: background-color 0.15s ease;
          visibility: visible !important;
          color: #18181E;
          text-align: left;
        }

        .chat-widget-media-chip:hover {
          background: #F4F4FF;
        }

        .chat-widget-media-chip-icon {
          width: 20px;
          height: 20px;
          flex-shrink: 0;
        }

        .chat-widget-media-chip-label {
          font-size: ${fontSizes.body};
          line-height: 20px;
          font-weight: 400;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 220px;
        }

        .chat-widget-message-content:empty {
          display: none;
        }
        
        /* Ensure media chips are always visible */
        .chat-widget-message-content .chat-widget-media-chip {
          display: flex !important;
          visibility: visible !important;
          opacity: 1 !important;
        }

        .chat-widget-preview-modal {
          animation: fadeIn 0.2s ease-in;
        }

        .chat-widget-preview-content {
          animation: slideUp 0.3s ease-out;
        }

        @keyframes slideUp {
          from {
            transform: translateY(20px);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }

        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
    `;

    const chatIcon = `<svg class="chat-widget-launcher-default-icon" width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<path d="M4 10C4 8.93913 4.42143 7.92172 5.17157 7.17157C5.92172 6.42143 6.93913 6 8 6H22C23.0609 6 24.0783 6.42143 24.8284 7.17157C25.5786 7.92172 26 8.93913 26 10V18C26 19.0609 25.5786 20.0783 24.8284 20.8284C24.0783 21.5786 23.0609 22 22 22H18L12 28V22H8C6.93913 22 5.92172 21.5786 5.17157 20.8284C4.42143 20.0783 4 19.0609 4 18V10Z" fill="white"/>
<path d="M30 14V18C30 20.1217 29.1572 22.1566 27.6569 23.6569C26.1566 25.1571 24.1218 26 22 26H19.656L16.124 29.534C16.684 29.832 17.322 30 18 30H22L28 36V30H32C33.0609 30 34.0783 29.5786 34.8284 28.8284C35.5786 28.0783 36 27.0609 36 26V18C36 16.9391 35.5786 15.9217 34.8284 15.1716C34.0783 14.4214 33.0609 14 32 14H30Z" fill="white"/>
</svg>`;

    const messageBubbleIcon = `<svg class="chat-widget-launcher-default-icon" width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<path d="M5 25C5 25.8841 5.35119 26.7319 5.97631 27.357C6.60143 27.9821 7.44928 28.3333 8.33333 28.3333H28.3333L35 35V8.33333C35 7.44928 34.6488 6.60143 34.0237 5.97631C33.3986 5.35119 32.5507 5 31.6667 5H8.33333C7.44928 5 6.60143 5.35119 5.97631 5.97631C5.35119 6.60143 5 7.44928 5 8.33333V25Z" stroke="white" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

    const closeIcon = `<svg class="chat-widget-launcher-close-icon" width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M24 8L8 24" stroke="white" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 8L24 24" stroke="white" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    const container = document.createElement("div");
    container.className = "chat-widget-container";

    const headerTitle = resolveChatWindowTitleForUi();
    const headerFallbackSvg = chatIcon.replace(
      /class="chat-widget-launcher-default-icon"\s+/,
      "",
    );
    const headerLogoImg = resolvedHeaderLogoUrl
      ? `<img src="${resolvedHeaderLogoUrl}" class="chat-widget-header-logo" alt="Logo" />`
      : `<div class="chat-widget-header-logo" style="display:flex;align-items:center;justify-content:center;color:#7c3aed">${headerFallbackSvg}</div>`;
    const headerSubtitleHtml = subtitle
      ? `<div class="chat-widget-header-subtitle" style="font-size:${fontSizes.meta};opacity:0.9">${escapeHtmlWidget(subtitle)}</div>`
      : "";
    const showHeaderClose = Boolean(preview.showHeaderClose);
    const headerCloseHtml = showHeaderClose
      ? `<button type="button" class="chat-widget-header-close" id="chatHeaderClose" aria-label="Close widget">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>`
      : "";

    const poweredByMarkSvg = `<svg class="chat-widget-powered-by-mark" width="16" height="16" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<rect width="32" height="32" rx="16" transform="matrix(-1 0 0 1 32 0)" fill="white"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M16.0005 2.5625C23.4233 2.5625 29.4405 8.57979 29.4405 16.0025C29.4405 23.4252 23.4233 29.4425 16.0005 29.4425C8.57784 29.4425 2.56055 23.4252 2.56055 16.0025C2.56055 8.57979 8.57784 2.5625 16.0005 2.5625ZM16.0005 3.60977C9.15623 3.60977 3.60782 9.15819 3.60782 16.0025C3.60782 22.8468 9.15623 28.3952 16.0005 28.3952C22.8449 28.3952 28.3933 22.8468 28.3933 16.0025C28.3933 9.15819 22.8449 3.60977 16.0005 3.60977Z" fill="url(#paint0_poweredby)"/>
<path d="M24.6986 11.5066C24.5218 10.9089 24.2263 10.4429 23.8319 10.1327C23.4154 9.80523 22.9049 9.65744 22.3206 9.71547C21.7937 9.76761 21.2089 9.99373 20.5868 10.4152L20.5573 10.4363C20.5511 10.441 17.8236 12.7353 17.8236 12.7353L18.5602 13.5205C18.5602 13.5205 21.0756 11.3966 21.2081 11.2935C21.6673 10.9851 22.0769 10.8219 22.4265 10.7872C22.7205 10.7582 22.9702 10.8269 23.1664 10.9811C23.3845 11.1525 23.5548 11.4338 23.6664 11.8107C23.8519 12.4379 23.8695 13.2938 23.6793 14.3285L23.6772 14.3413C23.6745 14.3579 23.0611 18.2028 22.8752 18.9969C22.6901 19.7877 22.4053 20.3927 22.0206 20.7699C21.821 20.9654 21.5915 21.0993 21.3319 21.164C21.0581 21.2324 20.742 21.2278 20.383 21.1436C19.329 20.8963 17.9725 19.9953 16.3004 18.2859L16.2898 18.2753L15.8948 17.8965L15.1465 18.6702L15.5418 19.05C17.3621 20.909 18.8947 21.9023 20.1382 22.194C20.6666 22.318 21.1503 22.3197 21.5887 22.2103C22.0413 22.0971 22.4364 21.8691 22.7748 21.5374C23.3106 21.0123 23.6929 20.23 23.9245 19.2412C24.1077 18.4592 24.707 14.711 24.7377 14.5182C24.959 13.3127 24.9295 12.2869 24.6986 11.5067V11.5066Z" fill="url(#paint1_poweredby)"/>
<path d="M13.6479 18.4093L14.2517 17.8029L15.0115 17.0405L16.9154 15.1311L17.1276 15.343L17.5651 13.7132L15.9324 14.1499L16.1535 14.3706L13.4742 17.0585L12.8921 17.6429L12.1719 18.3656L12.0675 18.4706L12.0611 18.477C11.4621 19.0968 10.8194 19.6911 10.2697 19.8292C9.86458 19.931 9.45724 19.6888 9.08324 18.7817C9.00007 18.4673 8.4387 16.3472 8.27409 15.7593C8.10887 15.103 8.12019 14.6058 8.2629 14.2716C8.34286 14.0844 8.46798 13.9532 8.62607 13.8814C8.80594 13.7993 9.04313 13.7816 9.32265 13.8313C9.95673 13.9444 10.7398 14.3931 11.5464 15.2108L11.5569 15.2214L12.5811 16.2023L13.3918 15.4877L12.3043 14.4465C11.3339 13.4657 10.3449 12.9186 9.5083 12.7696C9.01557 12.682 8.56247 12.7289 8.17875 12.9037C7.7735 13.0884 7.46027 13.4065 7.27093 13.8504C7.03915 14.3931 7.00151 15.1242 7.22726 16.0206L7.23144 16.0353C7.41143 16.6754 8.04945 19.0883 8.05117 19.0953L8.0615 19.1341L8.07245 19.1605C8.71231 20.7359 9.5842 21.1126 10.5314 20.8745C11.3379 20.6716 12.1259 19.9595 12.838 19.223L12.9219 19.1385L13.6481 18.4097L13.6479 18.4093Z" fill="url(#paint2_poweredby)"/>
<path d="M13.6514 18.4178L14.2546 17.8121L15.0136 17.0504L16.9153 15.143L17.1273 15.3546L17.5643 13.7266L15.9334 14.1628L16.1543 14.3833L13.4779 17.0684L12.8965 17.6522L12.1771 18.3742L12.0728 18.4791L12.0664 18.4854C11.468 19.1046 10.8244 19.6918 10.2769 19.8362C10.156 19.8681 10.0035 19.8724 9.84375 19.7988C9.84375 19.7988 9.26947 20.7471 9.31839 20.774C9.66642 20.9653 10.1114 20.9876 10.5381 20.8802C11.3438 20.6775 12.1309 19.9661 12.8422 19.2305L12.926 19.1461L13.6514 18.418V18.4178Z" fill="url(#paint3_poweredby)"/>
<defs>
<linearGradient id="paint0_poweredby" x1="29.4407" y1="26.0825" x2="1.76989" y2="25.0397" gradientUnits="userSpaceOnUse">
<stop stop-color="#EF32D4"/>
<stop offset="0.449646" stop-color="#912FF5"/>
<stop offset="1" stop-color="#7DBCFE"/>
</linearGradient>
<linearGradient id="paint1_poweredby" x1="7.84806" y1="19.7277" x2="24.6921" y2="15.2184" gradientUnits="userSpaceOnUse">
<stop stop-color="#7DBCFE"/>
<stop offset="0.6" stop-color="#912FF5"/>
<stop offset="1" stop-color="#EF32D4"/>
</linearGradient>
<linearGradient id="paint2_poweredby" x1="7.58231" y1="17.3497" x2="27.1331" y2="12.1016" gradientUnits="userSpaceOnUse">
<stop stop-color="#7DBCFE"/>
<stop offset="0.34" stop-color="#912FF5"/>
<stop offset="1" stop-color="#EF32D4"/>
</linearGradient>
<linearGradient id="paint3_poweredby" x1="8.76488" y1="18.7173" x2="26.8533" y2="13.8621" gradientUnits="userSpaceOnUse">
<stop stop-color="#21C8FF" stop-opacity="0"/>
<stop offset="0.09" stop-color="#21C8FF" stop-opacity="0.71"/>
<stop offset="0.14" stop-color="#21C8FF"/>
</linearGradient>
</defs>
</svg>`;

    const appearForLauncher = settings.appearance || {};
    const rawLauncherIconType =
      preview.launcherIconType || appearForLauncher.launcherIconType || "chat";
    const launcherIconType =
      rawLauncherIconType === "message"
        ? "message"
        : rawLauncherIconType === "custom" || rawLauncherIconType === "brand"
          ? "custom"
          : "chat";
    const launcherType =
      preview.launcherType || appearForLauncher.launcherType || "bubble";
    const launcherText = String(
      preview.launcherText ?? appearForLauncher.launcherText ?? "",
    ).trim();
    let launcherImgResolved = "";
    if (launcherIconType === "custom") {
      launcherImgResolved =
        resolvedLauncherCustomUrl || resolvedBrandLogoUrl || "";
    }
    const defaultLauncherIcon =
      launcherIconType === "message" ? messageBubbleIcon : chatIcon;
    const launcherIconHtml = launcherImgResolved
      ? `<img src="${launcherImgResolved}" alt="Chat" />`
      : defaultLauncherIcon;
    const launcherContent =
      launcherType === "text"
        ? `${launcherIconHtml}${
            launcherText
              ? `<span class="chat-widget-launcher-text-label">${escapeHtmlWidget(launcherText)}</span>`
              : ""
          }`
        : launcherIconHtml;
    const launcherTextHoverTooltipHtml =
      launcherType === "text" && launcherText
        ? `<div class="chat-widget-launcher-text-hover-tooltip ${
            isRight
              ? "chat-widget-launcher-text-hover-tooltip-left"
              : "chat-widget-launcher-text-hover-tooltip-right"
          }">${escapeHtmlWidget(launcherText)}</div>`
        : "";
    const launcherTooltipHtml =
      launcherType !== "text" && launcherText
        ? `<div class="chat-widget-launcher-tooltip ${
            isRight
              ? "chat-widget-launcher-tooltip-left"
              : "chat-widget-launcher-tooltip-right"
          }">${escapeHtmlWidget(launcherText)}</div>`
        : "";

    const pulseRingHtml =
      bubbleAnimation === "pulse"
        ? `<div class="chat-widget-launcher-pulse-ring" aria-hidden="true"></div>`
        : "";

    const launcherShapeClass =
      launcherType === "floating"
        ? " chat-widget-launcher-floating"
        : launcherType === "text"
          ? " chat-widget-launcher-text"
          : launcherType === "custom"
            ? " chat-widget-launcher-custom"
            : "";

    container.innerHTML = `
      <div class="chat-widget-launcher ${launcherAnimClass}${launcherShapeClass}" id="launcherBtn"><span id="launcherEventBadge" class="chat-widget-launcher-badge hidden" aria-hidden="true"></span>${pulseRingHtml}<div class="chat-widget-launcher-inner" id="launcherInner">${launcherContent}</div>${launcherTooltipHtml}${launcherTextHoverTooltipHtml}</div>
      <div class="chat-widget-window" id="chatWindow">
        <div class="chat-widget-header">
          <div class="chat-widget-header-content">
            <div class="chat-widget-header-logo-wrap">
              ${headerLogoImg}
              <span class="chat-widget-online-dot hidden" id="headerOnlineDot" aria-hidden="true"></span>
            </div>
            <div class="chat-widget-header-text">
              <div class="chat-widget-header-title" id="chatHeaderTitle">${escapeHtmlWidget(headerTitle)}</div>
              ${headerSubtitleHtml}
            </div>
            <div class="chat-widget-header-agent-profile-wrap hidden" id="chatHeaderAgentProfile"></div>
            ${headerCloseHtml}
          </div>
        </div>
        <div class="chat-widget-messages-pane" id="chatMessagesPane">
          <div class="chat-widget-scroll-wrap">
            <div class="chat-widget-body chat-widget-body--chat" id="chatBody">
              <!-- Messages will be inserted here -->
              <!-- Typing indicator is appended at the end dynamically -->
            </div>
          </div>
        </div>
        <div class="chat-widget-footer-section hidden" id="chatFooterSection">
           <div class="chat-widget-footer" id="chatFooter">
             <div class="chat-widget-footer-row">
             <div class="chat-widget-input-wrapper">
               <input type="file" id="fileInput" style="display: none;" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx" multiple />
              <button type="button" class="chat-widget-attach-btn" id="attachBtn" title="Attach file" aria-label="Attach file">
                 <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.75" stroke-linecap="round" stroke-linejoin="round">
                   <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
                 </svg>
               </button>
               <input type="text" class="chat-widget-input" id="msgInput" placeholder="Type your message here.." />
             </div>
             <button class="chat-widget-send-btn" id="sendBtn">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M13.5822 12H6.45106C6.45106 11.7556 6.39979 11.5112 6.29815 11.2819L4.16007 6.50225C3.47646 4.97361 5.11173 3.44319 6.61926 4.19951L19.0151 10.4154C20.3283 11.0731 20.3283 12.927 19.0151 13.5847L6.62016 19.8006C5.11173 20.5569 3.47646 19.0256 4.16007 17.4978L6.29635 12.7181C6.39732 12.4919 6.4494 12.2473 6.44926 12" stroke="#18181E" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
             </button>
             </div>
             <div class="chat-widget-powered-by">
               <div class="chat-widget-powered-by-row">
                 <span class="chat-widget-powered-by-label">Powered by</span>
                 <div class="chat-widget-powered-by-trailing">
                   ${poweredByMarkSvg}
                   <span class="chat-widget-powered-by-brand">CX-Astra</span>
                 </div>
               </div>
             </div>
           </div>
        </div>
      </div>
    `;

    // @property must live in the document stylesheet — Shadow DOM stylesheets
    // do not support @property registration so --pulse-angle would never be
    // treated as an animatable <angle>, keeping the gradient static.
    const pulsePropertyStyleId = "unibox-pulse-angle-property";
    if (!document.getElementById(pulsePropertyStyleId)) {
      const propStyle = document.createElement("style");
      propStyle.id = pulsePropertyStyleId;
      propStyle.textContent = `
        @property --pulse-angle {
          syntax: "<angle>";
          inherits: false;
          initial-value: 0deg;
        }
      `;
      document.head.appendChild(propStyle);
    }

    shadow.appendChild(styleTag);
    shadow.appendChild(container);

    // --- 11. VIEW LOGIC ---
    const isFormEnabled = settings.preChatForm.enabled;
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    currentView = isFormEnabled && !hasSubmittedForm ? "form" : "chat";
    activePopupFormConfig = null;
    popupFormValues = {};
    popupFormError = "";
    isSubmittingPopupForm = false;

    const removeQuickRepliesFromBody = (bodyEl) => {
      if (!bodyEl) return;
      const existing = bodyEl.querySelectorAll(".chat-widget-quick-replies");
      existing.forEach((node) => node.remove());
    };

    const renderQuickRepliesInBody = (bodyEl, options, onSelect) => {
      removeQuickRepliesFromBody(bodyEl);
      const safeOptions = Array.isArray(options)
        ? options.filter(
            (o) =>
              o &&
              typeof o.title === "string" &&
              o.title.trim().length > 0 &&
              typeof o.onSelect === "function",
          )
        : [];
      if (safeOptions.length === 0) return;
      const wrap = document.createElement("div");
      wrap.className = "chat-widget-quick-replies";
      safeOptions.forEach((opt, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chat-widget-quick-reply-btn";
        btn.textContent = opt.title;
        btn.addEventListener("click", () => onSelect(opt, idx));
        wrap.appendChild(btn);
      });
      const typingIndicator = bodyEl.querySelector("#typingIndicator");
      if (typingIndicator) {
        bodyEl.insertBefore(wrap, typingIndicator);
      } else {
        bodyEl.appendChild(wrap);
      }
      requestAnimationFrame(() => {
        bodyEl.scrollTop = bodyEl.scrollHeight;
      });
    };

    const restoreThreadMessagesInBody = (bodyEl) => {
      if (!bodyEl) return;
      const uniqueMessages = [];
      const seenIds = new Set();
      messages.forEach((messageData, mapKey) => {
        if (!messageData || !messageData.element) return;
        const stableId = String(
          messageData.id || messageData.messageId || mapKey || "",
        ).trim();
        if (!stableId || seenIds.has(stableId)) return;
        seenIds.add(stableId);
        uniqueMessages.push(messageData);
      });
      uniqueMessages.sort((a, b) => {
        const aTs = toTimestampMs(
          getCanonicalMessageTimestamp(a) ?? a.timestamp ?? 0,
        );
        const bTs = toTimestampMs(
          getCanonicalMessageTimestamp(b) ?? b.timestamp ?? 0,
        );
        return aTs - bTs;
      });
      const typingIndicator = bodyEl.querySelector("#typingIndicator");
      uniqueMessages.forEach((messageData) => {
        const el = messageData.element;
        if (!el) return;
        if (typingIndicator) {
          bodyEl.insertBefore(el, typingIndicator);
        } else {
          bodyEl.appendChild(el);
        }
      });
    };

    renderView = () => {
      const body = shadow.getElementById("chatBody");
      const footerSection = shadow.getElementById("chatFooterSection");
      const footer = shadow.getElementById("chatFooter");
      body.innerHTML = "";

      // Clear body and add typing indicator at the END
      // Typing indicator should always be the LAST element in chat body
      body.innerHTML = "";

      body.className =
        "chat-widget-body " +
        (currentView === "form" || currentView === "popup-form"
          ? "chat-widget-body--form"
          : "chat-widget-body--chat");

      // Create typing indicator (will be appended at the end after messages are loaded)
      const typingIndicator = document.createElement("div");
      typingIndicator.className = "chat-widget-typing-indicator hidden";
      typingIndicator.id = "typingIndicator";
      typingIndicator.innerHTML = `
        <div class="chat-widget-typing-dots" aria-live="polite" aria-label="Typing">
          <div class="chat-widget-typing-dot"></div>
          <div class="chat-widget-typing-dot"></div>
          <div class="chat-widget-typing-dot"></div>
        </div>
      `;
      body.appendChild(typingIndicator);
      refreshHeaderPresence();

      if (currentView === "form") {
        footerSection.classList.add("hidden");

        const formPreview = settings.preview || {};
        const showGreetingByTime = Boolean(formPreview.greetingByTime);
        const welcomeTextForm =
          settings.appearance.header?.welcomeMessage ||
          settings.appearance.welcomeMessage ||
          "Hi there!";
        let dynamicWelcomePrefixForm = "";
        if (showGreetingByTime) {
          const hour = new Date().getHours();
          if (hour < 12) dynamicWelcomePrefixForm = "Good morning! ";
          else if (hour < 18) dynamicWelcomePrefixForm = "Good afternoon! ";
          else dynamicWelcomePrefixForm = "Good evening! ";
        }
        const composedWelcomeMessageForm = `${dynamicWelcomePrefixForm}${welcomeTextForm}`;
        const consentEnabled = Boolean(settings.preChatForm?.consentCheckbox);
        const consentText = String(
          settings.preChatForm?.consentText || "I agree to be contacted.",
        ).trim();

        const fieldsHtml = settings.preChatForm.fields
          .map((f) => {
            let inputHtml = "";
            const isRequired = f.required ? "required" : "";

            if (f.type === "textarea") {
              inputHtml = `<textarea class="chat-widget-form-input" name="${f.id}" ${isRequired} placeholder="${f.label}"></textarea>`;
            } else {
              const inputType = f.type === "phone" ? "tel" : f.type;
              inputHtml = `<input class="chat-widget-form-input" type="${inputType}" name="${f.id}" ${isRequired} placeholder="${f.label}">`;
            }

            return `
            <div style="margin-bottom: 16px;">
              <label style="display: block; margin-bottom: 8px; font-size: 14px; line-height: 16px; color: #4D4D58;">${f.label}</label>
              ${inputHtml}
            </div>
          `;
          })
          .join("");
        const consentHtml = consentEnabled
          ? `<div style="margin: 8px 0 16px;">
              <label style="display:flex; gap:8px; align-items:flex-start; font-size:${fontSizes.meta}; color:#374151;">
                <input type="checkbox" id="preChatConsent" required style="margin-top:2px;" />
                <span>${escapeHtmlWidget(consentText || "I agree to be contacted.")}</span>
              </label>
            </div>`
          : "";

        const formContainer = document.createElement("div");
        formContainer.className = "chat-widget-form-container";
        formContainer.innerHTML = `
          <form id="preChatForm">
            ${fieldsHtml}
            ${consentHtml}
            <button type="submit" class="chat-widget-form-btn" disabled>Start Chat</button>
          </form>
        `;
        body.appendChild(formContainer);

        const formEl = formContainer.querySelector("#preChatForm");
        const consentEl = formContainer.querySelector("#preChatConsent");
        const submitBtn = formContainer.querySelector(".chat-widget-form-btn");
        const syncPreChatSubmitState = () => {
          if (!submitBtn) return;
          const consentOk = !consentEnabled || !consentEl || consentEl.checked;
          const formValid =
            typeof formEl.checkValidity === "function"
              ? formEl.checkValidity()
              : true;
          submitBtn.disabled = !(consentOk && formValid);
        };
        formEl
          .querySelectorAll("input, textarea, select")
          .forEach((fieldEl) => {
            fieldEl.addEventListener("input", syncPreChatSubmitState);
            fieldEl.addEventListener("change", syncPreChatSubmitState);
          });
        syncPreChatSubmitState();
        formEl.addEventListener("submit", (e) => {
          e.preventDefault();
          if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = "Submitting...";
          }
          if (consentEnabled && consentEl && !consentEl.checked) {
            alert("Please accept the consent checkbox to continue.");
            syncPreChatSubmitState();
            return;
          }
          const formData = new FormData(formEl);
          const data = Object.fromEntries(formData.entries());

          let capturedName = "";
          let capturedEmail = "";

          settings.preChatForm.fields.forEach((field) => {
            const val = data[field.id];
            if (!val) return;
            if (
              field.type === "text" &&
              (field.label.toLowerCase().includes("name") ||
                field.id.toLowerCase().includes("name"))
            )
              capturedName = val;
            if (
              field.type === "email" ||
              field.id.toLowerCase().includes("email")
            )
              capturedEmail = val;
          });

          if (!capturedName && capturedEmail) capturedName = capturedEmail;

          const preChatFieldMappings = settings.preChatForm.fields.map((field) => ({
            key: field.id,
            crmPath:
              typeof field.crmPath === "string" && field.crmPath.trim()
                ? field.crmPath.trim()
                : `lead.${field.id}`,
            inputType: field.type,
          }));

          sessionStorage.setItem(SESSION_KEY_FORM, "true");
          sessionStorage.setItem(SESSION_KEY_FORM_DATA, JSON.stringify(data));
          sessionStorage.setItem(
            SESSION_KEY_FORM_MAPPINGS,
            JSON.stringify(preChatFieldMappings),
          );
          if (capturedName)
            sessionStorage.setItem(`${SESSION_KEY_FORM}_name`, capturedName);
          if (capturedEmail)
            sessionStorage.setItem(`${SESSION_KEY_FORM}_email`, capturedEmail);

          currentView = "chat";
          renderView();
          appendMessageToUI(
            "Form submitted",
            "user",
            `prechat_submit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            new Date(),
            "sent",
            null,
            false,
            null,
            "text",
            null,
          );
        });
      } else if (currentView === "popup-form" && activePopupFormConfig) {
        footerSection.classList.add("hidden");
        const formContainer = document.createElement("div");
        formContainer.className = "chat-widget-form-container";
        let syncPopupSubmitState = () => {};

        const titleEl = document.createElement("div");
        titleEl.style.fontSize = "14px";
        titleEl.style.lineHeight = "24px";
        titleEl.style.fontWeight = "600";
        titleEl.style.color = "#18181E";
        titleEl.textContent = activePopupFormConfig.formTitle;
        formContainer.appendChild(titleEl);

        const formEl = document.createElement("form");
        activePopupFormConfig.fields.forEach((field) => {
          const wrapper = document.createElement("div");
          wrapper.style.marginBottom = "16px";

          const label = document.createElement("label");
          label.style.display = "block";
          label.style.marginBottom = "8px";
          label.style.fontSize = "12px";
          label.style.lineHeight = "16px";
          label.style.color = "#4b5563";
          label.textContent = field.prompt;
          wrapper.appendChild(label);

          if (field.inputType === "dropdown" && field.options.length > 0) {
            const select = document.createElement("select");
            select.className = "chat-widget-form-input";
            select.required = field.required;
            select.value = String(popupFormValues[field.key] || "");
            const emptyOption = document.createElement("option");
            emptyOption.value = "";
            emptyOption.textContent = "Select";
            select.appendChild(emptyOption);
            field.options.forEach((option) => {
              const optionEl = document.createElement("option");
              optionEl.value = option;
              optionEl.textContent = option;
              select.appendChild(optionEl);
            });
            select.addEventListener("change", (event) => {
              popupFormValues[field.key] = String(event.target.value || "");
              syncPopupSubmitState();
            });
            wrapper.appendChild(select);
          } else {
            const input = document.createElement("input");
            input.className = "chat-widget-form-input";
            input.type =
              field.inputType === "phone"
                ? "tel"
                : field.inputType === "email"
                  ? "email"
                  : "text";
            input.required = field.required;
            input.placeholder = field.prompt;
            input.value = String(popupFormValues[field.key] || "");
            input.addEventListener("input", (event) => {
              popupFormValues[field.key] = String(event.target.value || "");
              syncPopupSubmitState();
            });
            wrapper.appendChild(input);
          }
          formEl.appendChild(wrapper);
        });

        const errorEl = document.createElement("div");
        errorEl.style.marginBottom = "8px";
        errorEl.style.color = "#B91C1C";
        errorEl.style.fontSize = "12px";
        errorEl.style.lineHeight = "16px";
        errorEl.style.display = popupFormError ? "block" : "none";
        errorEl.textContent = popupFormError || "";
        formEl.appendChild(errorEl);

        const submitBtn = document.createElement("button");
        submitBtn.type = "submit";
        submitBtn.className = "chat-widget-form-btn";
        submitBtn.textContent = isSubmittingPopupForm ? "Submitting..." : "Submit";
        const syncPopupSubmitStateImpl = () => {
          const canSubmit =
            !isSubmittingPopupForm && isPopupFormReadyToSubmit(activePopupFormConfig);
          submitBtn.disabled = !canSubmit;
          submitBtn.style.background = canSubmit ? "" : "#D1D5DB";
          submitBtn.style.color = canSubmit ? "" : "#6B7280";
          submitBtn.style.cursor = canSubmit ? "pointer" : "not-allowed";
        };
        syncPopupSubmitState = syncPopupSubmitStateImpl;
        syncPopupSubmitState();
        formEl.appendChild(submitBtn);

        formEl.addEventListener("submit", (event) => {
          event.preventDefault();
          if (!activePopupFormConfig || isSubmittingPopupForm) return;

          const formData = {};
          let firstError = "";
          activePopupFormConfig.fields.forEach((field) => {
            const rawValue = String(popupFormValues[field.key] || "").trim();
            formData[field.key] = rawValue;
            if (!firstError && field.required && !rawValue) {
              firstError =
                field.retryMessage || `Please enter a valid value for ${field.prompt}`;
            } else if (!firstError && rawValue) {
              if (
                field.inputType === "email" &&
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawValue)
              ) {
                firstError =
                  field.retryMessage ||
                  `Please enter a valid value for ${field.prompt}`;
              }
              if (
                !firstError &&
                field.inputType === "phone" &&
                !/^\+?\d{7,15}$/.test(rawValue.replace(/[\s-]/g, ""))
              ) {
                firstError =
                  field.retryMessage ||
                  `Please enter a valid value for ${field.prompt}`;
              }
            }
          });
          if (firstError) {
            popupFormError = firstError;
            renderView();
            return;
          }

          popupFormError = "";
          isSubmittingPopupForm = true;
          renderView();
          const fieldMappings = activePopupFormConfig.fields.map((field) => ({
            key: field.key,
            crmPath: field.crmPath || "",
            inputType: field.inputType,
          }));
          sendMessageToApi("Message submitted", {
            interactivePayload: {
              event: "workflow_form_submit",
              mode: "popup",
              nodeId: activePopupFormConfig.nodeId,
              formData,
              fieldMappings,
            },
          })
            .then(() => {
              activePopupFormConfig = null;
              popupFormValues = {};
              popupFormError = "";
              isSubmittingPopupForm = false;
              currentView = "chat";
              renderView();
            })
            .catch((err) => {
              console.error("UniBox: Failed to submit popup form", err);
              isSubmittingPopupForm = false;
              popupFormError = "Unable to submit form. Please try again.";
              renderView();
            });
        });

        formContainer.appendChild(formEl);
        body.appendChild(formContainer);
      } else {
        footerSection.classList.remove("hidden");
        setInitialBodyLoading(false);
        syncAgentTitleUi();
        restoreThreadMessagesInBody(body);

        // Re-render file chips if there are selected files
        if (selectedFiles.length > 0) {
          setTimeout(() => renderFileChips(), 50);
        }

        // Show welcome message if not already shown and no messages exist
        if (!staticWelcomeShown) {
          const welcomeText =
            settings.appearance.header?.welcomeMessage ||
            settings.appearance.welcomeMessage;
          const initialFlow = normalizeFlowPayload(settings.initialFlow);
          if (welcomeText) {
            // Check if there are any existing messages
            const hasMessages = Array.from(messages.values()).length > 0;
            if (!hasMessages) {
              appendMessageToUI(
                welcomeText,
                "agent",
                `static_welcome_${Date.now()}`,
                new Date(),
                "sent",
                null,
                false,
                null,
                "text",
                undefined,
                initialFlow,
              );
              const initialFollowUps = Array.isArray(settings.initialFollowUpMessages)
                ? settings.initialFollowUpMessages
                : [];
              if (initialFollowUps.length > 0) {
                initialFollowUps.forEach((followUp, idx) => {
                  const followUpText = String(followUp?.text || "").trim();
                  const followUpFlow = normalizeFlowPayload(followUp?.flow);
                  if (!followUpText && !followUpFlow) return;
                  appendMessageToUI(
                    followUpText || "",
                    "agent",
                    `static_welcome_followup_${Date.now()}_${idx}`,
                    new Date(),
                    "sent",
                    null,
                    false,
                    null,
                    "text",
                    undefined,
                    followUpFlow,
                  );
                });
              }
              staticWelcomeShown = true;
              waitingForFirstInboundMessage = false;
              setInitialBodyLoading(false);
            }
          }
        }

        const previewCfg = settings.preview || {};
        const quickReplyOptions = Array.isArray(previewCfg.quickReplyOptions)
          ? previewCfg.quickReplyOptions
              .map((opt) => String(opt || "").trim())
              .filter(Boolean)
          : [];
        const botIntroMessage = String(
          previewCfg.botIntroductionMessage || "",
        ).trim();
        const demoFlow = previewCfg.demoFlow;
        const hasDemoFlow =
          demoFlow &&
          Array.isArray(demoFlow.messages) &&
          demoFlow.messages.length > 0;

        const handleDemoQuickReply = (pickedOption) => {
          const messageMap = getMessageMapFromDemoFlow(demoFlow);
          const qaMap = getQuickActionMapFromDemoFlow(demoFlow);
          const userText = String(pickedOption?.title || "").trim();
          if (!userText) return;
          const flowOptionId = String(
            pickedOption?.id || pickedOption?.optionId || userText,
          ).trim();
          appendMessageToUI(
            userText,
            "user",
            `demo_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            new Date(),
            "sent",
            null,
            false,
            null,
            "text",
            null,
          );
          sendMessageToApi(userText, {
            type: "interactive",
            flowSelection: {
              id: flowOptionId || null,
              title: userText,
              nextNodeId: String(pickedOption?.nextMessageId || "").trim() || null,
              source: "quick_reply_demo_flow",
            },
            interactive: {
              button_reply: {
                id: flowOptionId || userText,
                title: userText,
              },
            },
          }).catch((err) => {
            console.error("UniBox: Failed to send demo quick reply", err);
          });
          const target = messageMap.get(String(pickedOption.nextMessageId || ""));
          if (target && String(target.text || "").trim()) {
            appendMessageToUI(
              String(target.text || "").trim(),
              "agent",
              `demo_agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              new Date(),
              "sent",
              null,
              false,
              null,
              "text",
              null,
            );
          }
          if (target && String(target.nextEndText || "").trim()) {
            appendMessageToUI(
              String(target.nextEndText || "").trim(),
              "agent",
              `demo_end_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              new Date(),
              "sent",
              null,
              false,
              null,
              "text",
              null,
            );
          }
          const qa =
            target && target.nextQuickActionId != null
              ? qaMap.get(String(target.nextQuickActionId))
              : null;
          demoQuickReplies = (qa?.options || [])
            .map((nextOpt) => ({
              title: String(nextOpt.title || "").trim(),
              nextMessageId: String(nextOpt.nextMessageId || "").trim(),
            }))
            .filter(
              (nextOpt) =>
                nextOpt.title &&
                nextOpt.nextMessageId &&
                messageMap.has(nextOpt.nextMessageId),
            );
          showQuickReplies = demoQuickReplies.length > 0;
          if (!showQuickReplies) {
            removeQuickRepliesFromBody(body);
            return;
          }
          renderQuickRepliesInBody(
            body,
            demoQuickReplies.map((opt) => ({
              title: opt.title,
              onSelect: () => {},
              nextMessageId: opt.nextMessageId,
            })),
            (nextPicked) => handleDemoQuickReply(nextPicked),
          );
        };

        if (hasDemoFlow && messages.size === 0) {
          const messageMap = getMessageMapFromDemoFlow(demoFlow);
          const qaMap = getQuickActionMapFromDemoFlow(demoFlow);
          const start = messageMap.get(String(demoFlow.startMessageId || ""));
          if (start && String(start.text || "").trim()) {
            appendMessageToUI(
              String(start.text || "").trim(),
              "agent",
              `demo_start_${Date.now()}`,
              new Date(),
              "sent",
              null,
              false,
              null,
              "text",
              null,
            );
          }
          const qa =
            start && start.nextQuickActionId != null
              ? qaMap.get(String(start.nextQuickActionId))
              : null;
          demoQuickReplies = (qa?.options || [])
            .map((opt) => ({
              title: String(opt.title || "").trim(),
              nextMessageId: String(opt.nextMessageId || "").trim(),
            }))
            .filter(
              (opt) =>
                opt.title &&
                opt.nextMessageId &&
                messageMap.has(opt.nextMessageId),
            );
          showQuickReplies = demoQuickReplies.length > 0;
        } else if (!hasDemoFlow && botIntroMessage && messages.size === 0) {
          appendMessageToUI(
            botIntroMessage,
            "agent",
            `bot_intro_${Date.now()}`,
            new Date(),
            "sent",
            null,
            false,
            null,
            "text",
            null,
          );
        }

        if (hasDemoFlow && showQuickReplies && demoQuickReplies.length > 0) {
          renderQuickRepliesInBody(
            body,
            demoQuickReplies.map((opt) => ({
              title: opt.title,
              onSelect: () => {},
              nextMessageId: opt.nextMessageId,
            })),
            (picked) => handleDemoQuickReply(picked),
          );
        } else if (!hasDemoFlow && showQuickReplies && quickReplyOptions.length > 0) {
          renderQuickRepliesInBody(
            body,
            quickReplyOptions.map((opt) => ({
              id: opt,
              title: opt,
              onSelect: () => {},
            })),
            (opt) => {
              const picked = String(opt.title || "").trim();
              if (!picked) return;
              const flowOptionId = String(opt.id || picked).trim();
              appendMessageToUI(
                picked,
                "user",
                `quick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                new Date(),
                "sent",
                null,
                false,
                null,
                "text",
                null,
              );
              sendMessageToApi(picked, {
                type: "interactive",
                flowSelection: {
                  id: flowOptionId || null,
                  title: picked,
                  nextNodeId: null,
                  source: "quick_reply",
                },
                interactive: {
                  button_reply: {
                    id: flowOptionId || picked,
                    title: picked,
                  },
                },
              }).catch((err) => {
                console.error("UniBox: Failed to send quick reply", err);
              });
              showQuickReplies = false;
              removeQuickRepliesFromBody(body);
            },
          );
        } else {
          removeQuickRepliesFromBody(body);
        }
      }
    };

    renderView();

    // --- 12. EVENTS ---
    const launcher = shadow.getElementById("launcherBtn");
    const launcherInner = shadow.getElementById("launcherInner");
    const windowEl = shadow.getElementById("chatWindow");
    const closeBtn = shadow.getElementById("closeBtn");
    const headerCloseBtn = shadow.getElementById("chatHeaderClose");
    const sendBtn = shadow.getElementById("sendBtn");
    const msgInput = shadow.getElementById("msgInput");
    const attachBtn = shadow.getElementById("attachBtn");
    const fileInput = shadow.getElementById("fileInput");

    const updateLauncherIcon = (isOpen) => {
      if (!launcherInner) return;
      if (isOpen) {
        launcher.classList.add("open");
        launcherInner.innerHTML = closeIcon;
      } else {
        launcher.classList.remove("open");
        launcherInner.innerHTML = launcherContent;
      }
    };

    const applyMobileExperienceStyles = () => {
      const mobile = getMobileExperienceConfig();
      if (!mobile.isMobile) return;
      if (mobile.mobileWindowStyle !== "fullscreen") return;
      windowEl.style.left = "0";
      windowEl.style.right = "0";
      windowEl.style.bottom = "0";
      windowEl.style.top = "0";
      windowEl.style.width = "100vw";
      windowEl.style.height = "100vh";
      windowEl.style.maxWidth = "100vw";
      windowEl.style.maxHeight = "100vh";
      windowEl.style.borderRadius = "0";
      windowEl.style.border = "0";
    };
    applyMobileExperienceStyles();

    const toggle = (forceState) => {
      const isOpen = windowEl.classList.contains("open");
      const nextState = forceState !== undefined ? forceState : !isOpen;
      const advanced = getAdvancedSettingsConfig();

      if (nextState) windowEl.classList.add("open");
      else windowEl.classList.remove("open");

      updateLauncherIcon(nextState);
      if (nextState) {
        setLauncherEventBadgeVisible(false);
      }
      refreshHeaderPresence();

      if (settings.behavior.stickyPlacement && advanced.persistentChat) {
        localStorage.setItem(STORAGE_KEY_OPEN, nextState);
      }
    };

    launcher.addEventListener("click", () => {
      maybeRequestNotificationPermission();
      toggle();
    });
    if (closeBtn) closeBtn.addEventListener("click", () => toggle(false));
    if (headerCloseBtn)
      headerCloseBtn.addEventListener("click", () => toggle(false));

    const handleSend = () => {
      const text = msgInput.value.trim();

      // If there are selected files, send them with caption
      if (selectedFiles.length > 0) {
        sendSelectedFiles(text || undefined).catch((err) => {
          console.error("UniBox: Failed to send media", err);
        });
        msgInput.value = "";
        return;
      }

      // Otherwise send text message
      if (!text) return;

      msgInput.value = "";

      const messageId = `msg_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;
      appendMessageToUI(
        text,
        "user",
        messageId,
        new Date(),
        "sent",
        null,
        false,
        null,
        "text",
        null,
      );

      sendMessageToApi(text).catch((err) => {
        console.error("UniBox: Failed to send message", err);
      });
    };

    if (attachBtn && fileInput) {
      attachBtn.addEventListener("click", () => {
        fileInput.click();
      });

      fileInput.addEventListener("change", (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length > 0) {
          files.forEach((file) => {
            sendMediaMessage(file).catch((err) => {
              console.error("UniBox: Failed to add media file", err);
            });
          });
          fileInput.value = ""; // Reset input
        }
      });
    }

    sendBtn.addEventListener("click", () => {
      maybeRequestNotificationPermission();
      handleSend();
    });
    msgInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        e.preventDefault(); // prevent accidental form submission if ever wrapped in a <form>
        if (isTyping) {
          isTyping = false;
          emitTypingStatus(false);
          if (typingTimeout) {
            clearTimeout(typingTimeout);
            typingTimeout = null;
          }
        }
        handleSend();
      } else {
        handleUserTyping();
      }
    });

    // Update send button state based on selected files or text
    const updateSendButtonState = () => {
      const hasText = msgInput.value.trim().length > 0;
      const hasFiles = selectedFiles.length > 0;
      sendBtn.disabled = !hasText && !hasFiles;
      sendBtn.style.opacity = hasText || hasFiles ? "1" : "0.5";
      sendBtn.style.cursor = hasText || hasFiles ? "pointer" : "not-allowed";
    };

    msgInput.addEventListener("input", updateSendButtonState);
    updateSendButtonState();

    // Re-render chips when footer becomes visible (in case it was hidden)
    // Use debounce to prevent excessive calls from MutationObserver
    let chipRenderDebounce = null;
    let isRenderingChips = false; // Prevent recursive calls

    const observer = new MutationObserver(() => {
      // Skip if we're already rendering (prevents infinite loop)
      if (isRenderingChips) return;

      if (selectedFiles.length > 0) {
        // Debounce to prevent excessive calls
        if (chipRenderDebounce) {
          clearTimeout(chipRenderDebounce);
        }
        chipRenderDebounce = setTimeout(() => {
          isRenderingChips = true;
          try {
            renderFileChips();
            updateSendButtonState();
          } finally {
            // Reset flag after a short delay to allow DOM to settle
            setTimeout(() => {
              isRenderingChips = false;
            }, 50);
          }
        }, 100);
      }
    });

    // NOTE: `footer` is defined inside `renderView` and not in this scope.
    // To avoid ReferenceError and still react to footer changes, we resolve
    // the footer element here via the shadow root before observing.
    const footerEl = shadow.getElementById("chatFooter");
    if (footerEl) {
      observer.observe(footerEl, { childList: true, subtree: true });
    }

    function handleUserTyping() {
      if (!isTyping) {
        isTyping = true;
        emitTypingStatus(true);
      }

      if (typingTimeout) {
        clearTimeout(typingTimeout);
      }

      typingTimeout = setTimeout(() => {
        isTyping = false;
        emitTypingStatus(false);
        typingTimeout = null;
      }, 3000);
    }

    /**
     * Mark contact as active/reading - sends presence update via WebSocket
     * ALL status updates go via WebSocket only - no HTTP API calls
     */
    function markContactAsRead() {
      const advanced = getAdvancedSettingsConfig();
      if (!advanced.visitorTrackingEnabled) return;
      if (!userId || settings.testMode) return;
      if (!conversationId) return;

      // Send presence/activity update via WebSocket ONLY
      wsSend({
        action: "presence",
        conversationId: conversationId,
        status: "active",
      });
    }

    const chatWindow = shadow.getElementById("chatWindow");
    const chatBody = shadow.getElementById("chatBody");
    if (chatBody) {
      let scrollTimeout;
      chatBody.addEventListener("scroll", () => {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          markVisibleMessagesAsRead();
        }, 500);
      });

      const observer = new MutationObserver(() => {
        if (chatWindow.classList.contains("open")) {
          markContactAsRead();
          markVisibleMessagesAsRead();
        }
      });
      observer.observe(chatWindow, {
        attributes: true,
        attributeFilter: ["class"],
      });

      if (chatWindow.classList.contains("open")) {
        setTimeout(() => {
          markContactAsRead();
          markVisibleMessagesAsRead();
        }, 500);
      }
    }

    const advanced = getAdvancedSettingsConfig();
    const mode = resolveAutoTriggerMode();
    const engagement = getEngagementTriggerConfig();
    const engagementSeenKey = `${STORAGE_KEY_ENGAGEMENT}_proactive`;
    const pageViewKey = `${STORAGE_KEY_ENGAGEMENT}_page_views`;
    const mobile = getMobileExperienceConfig();
    const pageViews = Number(sessionStorage.getItem(pageViewKey) || "0") + 1;
    sessionStorage.setItem(pageViewKey, String(pageViews));
    const hasHistory = localStorage.getItem(STORAGE_KEY_OPEN);
    const canAutoTrigger =
      !advanced.persistentChat || hasHistory === null || hasHistory === "true";
    const triggerOnce = (() => {
      let fired = false;
      return () => {
        if (fired || !canAutoTrigger) return;
        fired = true;
        toggle(true);
      };
    })();
    const triggerProactiveMessage = () => {
      if (!engagement.proactiveMessage) return;
      if (
        engagement.showOncePerSession &&
        sessionStorage.getItem(engagementSeenKey) === "true"
      ) {
        return;
      }
      triggerOnce();
      appendMessageToUI(
        engagement.proactiveMessage,
        "agent",
        `proactive_${Date.now()}`,
        new Date(),
        "sent",
        null,
        false,
        null,
        "text",
        undefined,
      );
      if (engagement.showOncePerSession) {
        sessionStorage.setItem(engagementSeenKey, "true");
      }
    };

    if (mobile.isMobile && mobile.autoOpenOnMobile) {
      setTimeout(() => triggerOnce(), 0);
    } else if (mode === "exit-intent") {
      const handleExitIntent = (event) => {
        const related = event.relatedTarget || event.toElement;
        if (related) return;
        if (typeof event.clientY === "number" && event.clientY <= 0) {
          triggerOnce();
          document.removeEventListener("mouseout", handleExitIntent);
        }
      };
      document.addEventListener("mouseout", handleExitIntent);
    } else if (mode === "on-scroll") {
      const threshold = Math.min(
        100,
        Math.max(1, Number(settings.behavior.showOnlyAfterScrollPercent || 0)),
      );
      const handleScrollTrigger = () => {
        const scrollTop =
          window.pageYOffset || document.documentElement.scrollTop || 0;
        const maxScroll =
          Math.max(
            document.documentElement.scrollHeight - window.innerHeight,
            0,
          ) || 1;
        const percent = (scrollTop / maxScroll) * 100;
        if (percent >= threshold) {
          triggerOnce();
          window.removeEventListener("scroll", handleScrollTrigger);
        }
      };
      window.addEventListener("scroll", handleScrollTrigger, { passive: true });
      handleScrollTrigger();
    } else if (mode === "after-delay") {
      const delay = Math.max(0, Number(settings.behavior.autoOpenDelay || 0));
      setTimeout(() => triggerOnce(), delay);
    } else if (mode === "immediately") {
      setTimeout(() => triggerOnce(), 0);
    }

    if (engagement.proactiveMessage) {
      if (engagement.triggerCondition === "scroll") {
        const threshold = Math.min(
          100,
          Math.max(1, Number(engagement.triggerValue || 30)),
        );
        const onScroll = () => {
          const scrollTop =
            window.pageYOffset || document.documentElement.scrollTop || 0;
          const maxScroll =
            Math.max(
              document.documentElement.scrollHeight - window.innerHeight,
              0,
            ) || 1;
          const percent = (scrollTop / maxScroll) * 100;
          if (percent >= threshold) {
            triggerProactiveMessage();
            window.removeEventListener("scroll", onScroll);
          }
        };
        window.addEventListener("scroll", onScroll, { passive: true });
      } else if (engagement.triggerCondition === "pages") {
        const pageTarget = Math.max(1, Number(engagement.triggerValue || 2));
        if (pageViews >= pageTarget) triggerProactiveMessage();
      } else if (engagement.triggerCondition === "returning") {
        if (Boolean(localStorage.getItem(STORAGE_KEY_USER))) {
          triggerProactiveMessage();
        }
      } else {
        const delayMs = Math.max(
          0,
          Number(engagement.triggerValue || 5) * 1000,
        );
        setTimeout(() => triggerProactiveMessage(), delayMs);
      }
    }
  }

  function deepMerge(target, source) {
    for (const key in source) {
      if (source[key] instanceof Object && key in target) {
        Object.assign(source[key], deepMerge(target[key], source[key]));
      }
    }
    Object.assign(target || {}, source);
    return target;
  }

  const loadedGoogleFontFamilies = new Set();

  function loadGoogleFont(font) {
    if (!font) return;
    const resolved = resolveWidgetFont(font);
    const family = resolved.split(",")[0].replace(/['"]/g, "").trim();
    const familyKey = family.toLowerCase();
    if (
      [
        "sans-serif",
        "serif",
        "system-ui",
        "system font",
        "segoe ui",
        "helvetica neue",
      ].includes(familyKey)
    )
      return;
    if (loadedGoogleFontFamilies.has(familyKey)) return;
    loadedGoogleFontFamilies.add(familyKey);
    const link = document.createElement("link");
    link.href = `https://fonts.googleapis.com/css2?family=${family.replace(
      / /g,
      "+",
    )}:wght@400;500;600&display=swap`;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
})();