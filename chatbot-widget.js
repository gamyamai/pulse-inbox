(function () {
  // --- 1. CONFIGURATION ---
  // Support both new encrypted method (window.UniBoxEmbedConfig) and legacy method (window.UniBoxSettings)

  let userConfig = null;

  // Check for new encrypted embed config
  if (window.UniBoxEmbedConfig) {
    try {
      const embedConfig = window.UniBoxEmbedConfig;
      const encryptedConfig = embedConfig.encryptedConfig;

      if (!encryptedConfig) {
        console.error('UniBox: Missing encryptedConfig in embed config.');
        return;
      }

      // Decrypt config using the same fixed key used for encryption
      function decryptConfig(encryptedData, key) {
        try {
          // Decode from base64
          const decoded = atob(encryptedData);
          // XOR decrypt
          let decrypted = '';
          for (let i = 0; i < decoded.length; i++) {
            const keyChar = key[i % key.length];
            decrypted += String.fromCharCode(
              decoded.charCodeAt(i) ^ keyChar.charCodeAt(0),
            );
          }
          // Decode from base64 to UTF-8 string
          const jsonString = decodeURIComponent(escape(atob(decrypted)));
          return JSON.parse(jsonString);
        } catch (e) {
          console.error('UniBox: Failed to decrypt config', e);
          return null;
        }
      }

      // Use the same encryption key (must match the one used in script generator)
      const encryptionKey = 'unibox-widget-encryption-key-2024';
      const decryptedConfig = decryptConfig(encryptedConfig, encryptionKey);

      if (decryptedConfig) {
        userConfig = decryptedConfig;
      } else {
        console.error('UniBox: Failed to decrypt config.');
        return;
      }
    } catch (e) {
      console.error('UniBox: Error processing embed config', e);
      return;
    }
  }
  // Fall back to legacy method
  else if (window.UniBoxSettings) {
    userConfig = window.UniBoxSettings;
  } else {
    console.error(
      'UniBox: Settings missing. Please configure window.UniBoxEmbedConfig or window.UniBoxSettings.',
    );
    return;
  }

  const requiredFields = ['tenantId', 'widgetToken', 'chatbotId'];
  const missingFields = requiredFields.filter((field) => !userConfig[field]);

  if (missingFields.length > 0) {
    console.error(
      `UniBox: Missing required fields: ${missingFields.join(', ')}`,
    );
    return;
  }

  // Get base URL - support both apiBaseUrl and baseUrl
  const baseUrl =
    userConfig.apiBaseUrl ||
    userConfig.baseUrl ||
    'https://dev-api.salesastra.ai/pulse/v1/chat';

  // Storage Keys (using tenantId from userConfig)
  const SESSION_KEY_FORM = `unibox_form_submitted_${userConfig.tenantId}`;
  const STORAGE_KEY_OPEN = `unibox_open_${userConfig.tenantId}`;
  const STORAGE_KEY_USER = `unibox_guest_${userConfig.tenantId}`;

  // API URLs - will be set after we get the full config
  let API_BASE = baseUrl;
  let API_S3_URL = '';
  let UTILITY_API_BASE = '';
  let UTILITY_S3_URL = '';
  let SOCKET_CONFIG = { namespaceUrl: '', path: '' };

  // Utility service URL for media (separate from logo S3)
  // Construct utility base URL from API_BASE: /pulse/v1/chat -> /utility/v1
  function getUtilityBaseUrl() {
    try {
      const urlObj = new URL(API_BASE);
      const basePath = urlObj.pathname.replace(/\/pulse\/v1\/chat\/?$/, '');
      return `${urlObj.protocol}//${urlObj.host}${basePath}/utility/v1`;
    } catch (e) {
      // Fallback if URL parsing fails
      return (
        API_BASE.replace(/\/pulse\/v1\/chat\/?$/, '/utilities/v1') ||
        'https://dev-api.salesastra.ai/utilities/v1'
      );
    }
  }

  // Socket Config Helper
  function getSocketConfig(apiBase) {
    try {
      const urlObj = new URL(apiBase);
      const basePath = urlObj.pathname.replace(/\/chat\/?$/, '');
      return {
        namespaceUrl: `${urlObj.protocol}//${urlObj.host}${basePath}/events`,
        path: `${basePath}/socket.io/`,
      };
    } catch (e) {
      console.error('UniBox: Invalid API URL', e);
      return { namespaceUrl: '', path: '' };
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
          '/pulse/v1/public/chatbot/config',
        );
      } else {
        // Otherwise, construct the full path
        configPath = '/pulse/v1/public/chatbot/config';
      }

      const configUrl = `${urlObj.protocol}//${urlObj.host}${configPath}`;
      // Add chatbotId as query parameter
      const urlWithParams = new URL(configUrl);
      urlWithParams.searchParams.set('chatbotId', userConfig.chatbotId);
      return urlWithParams.toString();
    } catch (e) {
      // Fallback if URL parsing fails
      const fallbackUrl =
        baseUrl.replace(
          /\/pulse\/v1\/chat\/?$/,
          '/pulse/v1/public/chatbot/config',
        ) || 'https://dev-api.salesastra.ai/pulse/v1/public/chatbot/config';
      return `${fallbackUrl}?chatbotId=${encodeURIComponent(
        userConfig.chatbotId,
      )}`;
    }
  }

  const defaults = {
    tenantId: '',
    apiKey: '',
    widgetToken: '',
    testMode: false,
    appearance: {
      primaryColor: '#2563EB',
      secondaryColor: '#F3F4F6',
      backgroundColor: '#FFFFFF',
      fontFamily: 'Inter, sans-serif',
      iconStyle: 'rounded',
      logoUrl: '',
      header: {
        title: 'Support',
        welcomeMessage: 'Hi there! How can we help?',
        offlineMessage: 'We are currently offline.',
      },
      headerName: 'Support',
      welcomeMessage: 'Hi there! How can we help?',
      chatToggleIcon: {
        backgroundColor: '#2563EB',
        style: 'rounded',
      },
    },
    behavior: {
      botDelayMs: 600,
      typingIndicator: true,
      autoOpen: false,
      autoOpenDelay: 2000,
      stickyPlacement: 'bottom-right',
    },
    preChatForm: {
      enabled: false,
      fields: [],
    },
  };

  // Settings will be initialized after fetching config
  let settings = null;

  // --- 2. STATE ---
  let conversationId = null;
  let socket = null;
  let userId = localStorage.getItem(STORAGE_KEY_USER);
  let resolvedLogoUrl = '';
  let messages = new Map();
  let isAgentOnline = false;
  let staticWelcomeShown = false;
  let typingTimeout = null;
  let isTyping = false;
  let agentTyping = false;
  let previewMedia = null; // { url, filename, type, mediaKey } - for viewing received media
  let selectedFiles = []; // Array of { file, previewUrl, mediaType, fileName } - for file upload preview

  // --- 3. HELPER: HEADERS ---
  function getHeaders() {
    if (!settings) {
      console.error('UniBox: Settings not initialized');
      return {
        'Content-Type': 'application/json',
        'x-tenant-id': userConfig.tenantId,
        'x-api-key': userConfig.apiKey || userConfig.widgetToken, // General API key
        'x-chatbot-token': userConfig.widgetToken, // Widget-specific token
      };
    }
    return {
      'Content-Type': 'application/json',
      'x-tenant-id': settings.tenantId,
      'x-api-key': settings.apiKey || settings.widgetToken, // General API key
      'x-chatbot-token': settings.widgetToken, // Widget-specific token
    };
  }

  // --- 4. HELPER: UI LOADING STATE ---
  function setLoading(isLoading) {
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById('chatBody');
    if (!body) return;

    if (isLoading) {
      body.innerHTML = `
        <div class="chat-widget-loader">
          <div class="chat-widget-loader-spinner"></div>
        </div>
      `;
    } else {
      const loader = body.querySelector('.chat-widget-loader');
      if (loader) loader.remove();
    }
  }

  // --- 5. DEPENDENCY LOADER ---
  function loadSocketScript(callback) {
    if (window.io) {
      callback();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.socket.io/4.7.4/socket.io.min.js';
    script.onload = callback;
    document.head.appendChild(script);
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
        method: 'GET',
        headers: {
          'x-api-key': userConfig.apiKey || userConfig.widgetToken, // General API key, fallback to widgetToken
          'x-chatbot-token': userConfig.widgetToken, // Widget-specific token
          'x-tenant-id': userConfig.tenantId,
          origin: origin,
          referer: referer,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to fetch config: ${response.status} - ${errorText}`,
        );
      }

      const apiConfig = await response.json();

      // Transform API response to match widget structure
      const transformedConfig = {
        tenantId: userConfig.tenantId,
        widgetToken: userConfig.widgetToken,
        apiKey: userConfig.apiKey || userConfig.widgetToken, // Use apiKey if provided, otherwise fallback to widgetToken
        testMode: userConfig.testMode || false,
        appearance: apiConfig.widgetAppearance || defaults.appearance,
        behavior: {
          ...defaults.behavior,
          ...(apiConfig.widgetBehavior || {}),
          // Preserve autoOpen and autoOpenDelay from defaults if not in API response
          autoOpen:
            apiConfig.widgetBehavior?.autoOpen ?? defaults.behavior.autoOpen,
          autoOpenDelay:
            apiConfig.widgetBehavior?.autoOpenDelay ??
            defaults.behavior.autoOpenDelay,
        },
        preChatForm: apiConfig.preChatForm || defaults.preChatForm,
        // Store additional config that might be useful
        botFlow: apiConfig.botFlow,
        defaultLanguage: apiConfig.defaultLanguage,
        timezone: apiConfig.timezone,
      };

      return transformedConfig;
    } catch (error) {
      console.error('UniBox: Failed to fetch widget configuration:', error);
      // Fallback to defaults with user-provided minimal config
      return deepMerge(defaults, {
        tenantId: userConfig.tenantId,
        widgetToken: userConfig.widgetToken,
        apiKey: userConfig.apiKey || userConfig.widgetToken, // Use apiKey if provided, otherwise fallback to widgetToken
        chatbotId: userConfig.chatbotId,
        testMode: userConfig.testMode || false,
      });
    }
  }

  // --- 7. INITIALIZATION ---
  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }

  async function init() {
    try {
      // Fetch configuration from API
      const fetchedConfig = await fetchWidgetConfig();

      // Merge fetched config with defaults
      settings = deepMerge(defaults, fetchedConfig);

      // Now initialize API URLs and socket config with the baseUrl
      API_BASE = baseUrl;
      API_S3_URL = API_BASE.replace(/\/chat\/?$/, '/s3/generate-access-url');
      UTILITY_API_BASE = getUtilityBaseUrl();
      UTILITY_S3_URL = `${UTILITY_API_BASE}/s3/generate-access-url`;
      SOCKET_CONFIG = getSocketConfig(API_BASE);

      loadGoogleFont(settings.appearance.fontFamily);

      if (settings.appearance.logoUrl) {
        try {
          resolvedLogoUrl = await fetchLogoUrl(settings.appearance.logoUrl);
        } catch (err) {
          console.warn('UniBox: Failed to load logo', err);
        }
      }

      renderWidget();

      if (settings.testMode) {
        console.warn('UniBox: Running in TEST MODE.');
      }

      loadSocketScript(() => {
        if (userId) {
          const hasSubmittedForm =
            sessionStorage.getItem(SESSION_KEY_FORM) === 'true';
          if (!settings.preChatForm.enabled || hasSubmittedForm) {
            restoreExistingConversation();
          }
        }
      });
    } catch (error) {
      console.error('UniBox: Initialization failed:', error);
    }
  }

  // --- 8. S3 LOGIC ---

  /**
   * Fetch signed URL for logo/images (uses pulse service endpoint)
   * @param {string} fileName - The S3 key or file name
   * @returns {Promise<string>} - The presigned URL
   */
  async function fetchLogoUrl(fileName) {
    if (fileName.startsWith('http')) return fileName;
    try {
      const res = await fetch(API_S3_URL, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ fileName: fileName }),
      });
      if (!res.ok) throw new Error('S3 Sign failed');
      const data = await res.text();
      try {
        return JSON.parse(data).url || JSON.parse(data).signedUrl || data;
      } catch (e) {
        return data;
      }
    } catch (error) {
      return '';
    }
  }

  /**
   * Fetch signed URL for media files (uses utility service endpoint)
   * @param {string} key - The S3 key
   * @returns {Promise<string | null>} - The presigned URL or null if error
   */
  async function fetchMediaUrl(key) {
    if (!key) return null;

    // If a full URL is passed, return it as-is
    if (key.startsWith('http://') || key.startsWith('https://')) {
      return key;
    }

    try {
      const res = await fetch(UTILITY_S3_URL, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ key: key }),
      });

      if (!res.ok) {
        throw new Error('Failed to get media URL');
      }

      const data = await res.text();

      // Response is plain text (the presigned URL)
      const url = typeof data === 'string' ? data : String(data);

      // Validate that the response is a valid URL
      if (!url.startsWith('http')) {
        throw new Error('Invalid URL format returned from server');
      }

      return url;
    } catch (error) {
      console.error('UniBox: Error getting media access URL:', error);
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
        method: 'GET',
        headers: getHeaders(),
      });

      if (restoreRes.ok) {
        const data = await restoreRes.json();
        if (data.conversation) {
          conversationId = data.conversation.id;
          setLoading(false);

          if (data.messages && Array.isArray(data.messages)) {
            if (staticWelcomeShown) {
              const staticWelcome = Array.from(messages.values()).find(
                (msg) => msg.id && msg.id.startsWith('static_welcome_'),
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

              appendMessageToUI(
                normalizedTextValue,
                msg.sender || (msg.direction === 'inbound' ? 'user' : 'agent'),
                msg.id || msg.messageId,
                msg.timestamp || msg.timestamp_meta,
                msg.status,
                msg.readAt,
                msg.readByUs,
                msg.readByUsAt,
                msg.type,
                msg.media_storage_url,
              );
            });
            setTimeout(() => {
                sortMessagesByTimestamp();
                markVisibleMessagesAsRead();
            }, 500);
          }
          connectSocket();
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

  async function initializeConversation() {
    if (conversationId) return;

    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }

    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === 'true';
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.name = storedName;
      if (storedEmail) userDetails.email = storedEmail;
    }

    setLoading(true);

    try {
      if (!settings.testMode) {
        try {
          const restoreRes = await fetch(
            `${API_BASE}/thread/${userId}?limit=50`,
            {
              method: 'GET',
              headers: getHeaders(),
            },
          );
          if (restoreRes.ok) {
            const data = await restoreRes.json();
            if (data.conversation) {
              conversationId = data.conversation.id;
              setLoading(false);
              if (data.messages && Array.isArray(data.messages)) {
                data.messages.forEach((msg) => {
                  // Skip static welcome if we're restoring messages (welcome will be in messages)
                  if (
                    msg.sender === 'agent' &&
                    isWelcomeMessage(msg.text || msg.text_body)
                  ) {
                    staticWelcomeShown = true;
                  }

                  // Normalize text - convert empty string to null
                  const textValue = msg.text || msg.text_body;
                  const normalizedTextValue =
                    textValue && textValue.trim() ? textValue.trim() : null;

                  appendMessageToUI(
                    normalizedTextValue,
                    msg.sender ||
                      (msg.direction === 'inbound' ? 'user' : 'agent'),
                    msg.id || msg.messageId,
                    msg.timestamp || msg.timestamp_meta,
                    msg.status,
                    msg.readAt,
                    msg.readByUs,
                    msg.readByUsAt,
                    msg.type,
                    msg.media_storage_url,
                  );
                });
                markVisibleMessagesAsRead();
              }
              connectSocket();
              return;
            }
          }
        } catch (e) {}
      }

      const res = await fetch(`${API_BASE}/conversation`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          userId: userId,
          userName: userDetails.name || 'Guest User',
          userEmail: userDetails.email || '',
          testMode: settings.testMode,
        }),
      });

      if (!res.ok) throw new Error('Failed to start conversation');
      const data = await res.json();
      conversationId = data.conversationId;

      connectSocket();

      if (!settings.testMode) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const threadRes = await fetch(
            `${API_BASE}/thread/${userId}?limit=50`,
            {
              method: 'GET',
              headers: getHeaders(),
            },
          );

          setLoading(false);

          if (threadRes.ok) {
            const threadData = await threadRes.json();
            if (
              threadData.messages &&
              Array.isArray(threadData.messages) &&
              threadData.messages.length > 0
            ) {
              threadData.messages.forEach((msg) => {
                // Normalize text - convert empty string to null
                const textValue = msg.text || msg.text_body;
                const normalizedTextValue =
                  textValue && textValue.trim() ? textValue.trim() : null;

                appendMessageToUI(
                  normalizedTextValue,
                  msg.sender ||
                    (msg.direction === 'inbound' ? 'user' : 'agent'),
                  msg.id || msg.messageId,
                  msg.timestamp || msg.timestamp_meta,
                  msg.status,
                  msg.readAt,
                  msg.readByUs,
                  msg.readByUsAt,
                  msg.type,
                  msg.media_storage_url,
                );
              });
              setTimeout(() => {
                sortMessagesByTimestamp();
                markVisibleMessagesAsRead();
              }, 500);
            }
          } else {
            setLoading(false);
          }
        } catch (e) {
          setLoading(false);
        }
      } else {
        setLoading(false);
      }
    } catch (error) {
      console.error('UniBox: Init Error', error);
      setLoading(false);
    }
  }

  function connectSocket() {
    if (socket || !conversationId || !window.io) return;

    const options = {
      path: SOCKET_CONFIG.path,
      auth: {
        tenantId: settings.tenantId,
        'x-api-key': settings.apiKey || settings.widgetToken, // General API key
        'x-chatbot-token': settings.widgetToken, // Widget-specific token
      },
      query: {
        'x-api-key': settings.apiKey || settings.widgetToken, // General API key
        'x-chatbot-token': settings.widgetToken, // Widget-specific token
      },
      transports: ['polling', 'websocket'],
      transportOptions: {
        polling: {
          extraHeaders: {
            'x-api-key': settings.apiKey || settings.widgetToken, // General API key
            'x-chatbot-token': settings.widgetToken, // Widget-specific token
          },
        },
      },
      reconnection: true,
    };

    socket = window.io(SOCKET_CONFIG.namespaceUrl, options);

    socket.on('connect', () => {
      socket.emit('join', {
        type: 'chat',
        conversationId: conversationId,
        userId: userId,
        isAgent: false,
      });

      setTimeout(() => {
        if (userId && conversationId) {
          fetch(`${API_BASE}/thread/${userId}?limit=50`, {
            method: 'GET',
            headers: getHeaders(),
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((threadData) => {
              if (
                threadData &&
                threadData.messages &&
                Array.isArray(threadData.messages)
              ) {
                threadData.messages.forEach((msg) => {
                  // Normalize text - convert empty string to null
                  const textValue = msg.text || msg.text_body;
                  const normalizedTextValue =
                    textValue && textValue.trim() ? textValue.trim() : null;

                  appendMessageToUI(
                    normalizedTextValue,
                    msg.sender ||
                      (msg.direction === 'inbound' ? 'user' : 'agent'),
                    msg.id || msg.messageId,
                    msg.timestamp || msg.timestamp_meta,
                    msg.status,
                    msg.readAt,
                    msg.readByUs,
                    msg.readByUsAt,
                    msg.type,
                    msg.media_storage_url,
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
                'UniBox: Failed to fetch thread after socket connect',
                e,
              ),
            );
        }
      }, 500);
    });

    socket.on('read_receipt', (receipt) => {
      updateReadReceipt(receipt);
    });

    socket.on('typing', (data) => {
      if (data.conversationId === conversationId) {
        if (data.isAgent && data.isTyping) {
          agentTyping = true;
          showTypingIndicator(true);
        } else if (data.isAgent && !data.isTyping) {
          agentTyping = false;
          showTypingIndicator(false);
        }
      }
    });

    socket.on('message', (message) => {
      if (message.type === 'read_receipt') {
        updateReadReceipt(message);
        return;
      }

      const isUserMessage = message.sender === 'user';

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
        return;
      }

      if (isUserMessage) {
        const optimisticMessage = Array.from(messages.values()).find((msg) => {
          if (!msg.element || msg.sender !== 'user') return false;
          // RELAXED TIMING: Allow up to 30 seconds diff to account for network/server delay
          return (
            msg.text === message.text &&
            Math.abs(new Date(msg.timestamp) - new Date(message.timestamp)) <
              30000
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
          optimisticMessage.element.setAttribute(
            'data-message-id',
            message.messageId,
          );
          if (oldId && oldId !== message.messageId) {
            messages.delete(oldId);
          }
          messages.set(message.messageId, optimisticMessage);
          return;
        }
      }

      // Normalize text - convert empty string to null
      const textValue = message.text;
      const normalizedTextValue =
        textValue && textValue.trim() ? textValue.trim() : null;

      appendMessageToUI(
        normalizedTextValue,
        message.sender,
        message.messageId,
        message.timestamp,
        message.status,
        message.readAt,
        message.readByUs,
        message.readByUsAt,
        message.type,
        message.media_storage_url,
      );

      sortMessagesByTimestamp();

      if (!isUserMessage) {
        markVisibleMessagesAsRead();
      }
    });

    socket.on('online_status', (data) => {
      updateOnlineStatus(data.isOnline, data.isAgent);
    });

    socket.on('agent_online_status', (data) => {
      isAgentOnline = data.isOnline;
      updateOnlineStatusIndicator();
    });

    socket.on('connect_error', (err) => {
      console.error('UniBox: Socket Connection Error', err.message);
    });
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
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    if (type.startsWith('audio/')) return 'audio';
    if (
      type.includes('pdf') ||
      type.includes('document') ||
      type.includes('word') ||
      type.includes('excel') ||
      type.includes('sheet')
    )
      return 'document';
    return 'file';
  }

  /**
   * Upload a base64-encoded media file to S3 and get the S3 key.
   * This endpoint does NOT send the message - it only uploads to S3.
   * Use this if you want to upload once and send multiple times.
   */
  async function uploadMediaToS3(file) {
    try {
      const mediaBase64 = await fileToBase64(file);
      const mediaType = getMediaTypeFromFile(file);

      const response = await fetch(`${API_BASE}/media/upload`, {
        method: 'POST',
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
      console.error('UniBox: Media upload error', error);
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
   * Show file preview before sending
   */
  function showFilePreview(file) {
    const mediaType = getMediaTypeFromFile(file);
    const previewUrl = URL.createObjectURL(file);

    previewFile = {
      file: file,
      previewUrl: previewUrl,
      mediaType: mediaType,
      fileName: file.name || `file.${mediaType}`,
    };

    renderPreviewModal();
  }

  /**
   * Actually send the media message after preview confirmation
   */
  async function confirmSendMedia(caption) {
    if (!previewFile) return;

    const file = previewFile.file;
    const mediaType = previewFile.mediaType;
    const fileName = previewFile.fileName;

    // Validate file size
    try {
      validateFileSize(file);
    } catch (error) {
      console.error('UniBox: File validation error', error);
      alert(error.message || 'File size exceeds limit');
      closePreviewModal();
      return;
    }

    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }

    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === 'true';
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.userName = storedName;
      if (storedEmail) userDetails.userEmail = storedEmail;
    }

    // Show uploading indicator
    const messageId = `msg_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    try {
      if (conversationId && !socket) {
        connectSocket();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Show uploading indicator
      appendMessageToUI(
        `Uploading ${fileName}...`,
        'user',
        messageId,
        new Date(),
        'sent',
        null,
        false,
        null,
        mediaType,
        null,
      );

      // Convert file to base64
      const mediaBase64 = await fileToBase64(file);

      // Send media message (this endpoint uploads to S3 and sends in one call)
      const response = await fetch(`${API_BASE}/media/user`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          conversationId: conversationId || undefined,
          media_base64: mediaBase64,
          media_type: mediaType,
          userId: userId,
          userName: userDetails.userName,
          userEmail: userDetails.userEmail,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error?.message ||
            `Failed to send media: ${response.status}`,
        );
      }

      const result = await response.json();

      // Remove uploading indicator
      const host = document.getElementById('unibox-root');
      if (host && host.shadowRoot) {
        const body = host.shadowRoot.getElementById('chatBody');
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

      // Update conversation ID if this was a new conversation
      if (result.conversationId && !conversationId) {
        conversationId = result.conversationId;
        connectSocket();
      }

      // Close preview modal and cleanup
      closePreviewModal();

      // The message will be added via WebSocket, but we can also add it optimistically
      if (result.media_storage_url) {
        appendMessageToUI(
          caption || fileName,
          'user',
          result.messageId || messageId,
          result.timestamp || new Date(),
          result.status || 'sent',
          null,
          false,
          null,
          result.type || mediaType,
          result.media_storage_url,
        );
      }
      
      // FIX: Sort messages after sending media
      sortMessagesByTimestamp();

      return result;
    } catch (error) {
      console.error('UniBox: Send Media Error', error);

      // Update the uploading message to show error
      const host = document.getElementById('unibox-root');
      if (host && host.shadowRoot) {
        const body = host.shadowRoot.getElementById('chatBody');
        if (body) {
          const uploadingMsg = body.querySelector(
            `[data-message-id="${messageId}"]`,
          );
          if (uploadingMsg) {
            const content = uploadingMsg.querySelector(
              '.chat-widget-message-content',
            );
            if (content) {
              content.textContent = `Failed to upload: ${
                error.message || 'Unknown error'
              }`;
              content.style.color = '#ef4444';
            }
          }
        }
      }

      // Show user-friendly error
      alert(error.message || 'Failed to upload media. Please try again.');
      throw error;
    }
  }

  /**
   * Add file to selected files and show as chip
   */
  function addSelectedFile(file) {
    const mediaType = getMediaTypeFromFile(file);
    const previewUrl = URL.createObjectURL(file);

    selectedFiles.push({
      file: file,
      previewUrl: previewUrl,
      mediaType: mediaType,
      fileName: file.name || `file.${mediaType}`,
    });

    renderFileChips();

    // Update send button state
    const host = document.getElementById('unibox-root');
    if (host && host.shadowRoot) {
      const sendBtn = host.shadowRoot.getElementById('sendBtn');
      if (sendBtn) {
        const msgInput = host.shadowRoot.getElementById('msgInput');
        const hasText = msgInput && msgInput.value.trim().length > 0;
        const hasFiles = selectedFiles.length > 0;
        sendBtn.disabled = !hasText && !hasFiles;
        sendBtn.style.opacity = hasText || hasFiles ? '1' : '0.5';
        sendBtn.style.cursor = hasText || hasFiles ? 'pointer' : 'not-allowed';
      }
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
    const host = document.getElementById('unibox-root');
    if (host && host.shadowRoot) {
      const sendBtn = host.shadowRoot.getElementById('sendBtn');
      if (sendBtn) {
        const msgInput = host.shadowRoot.getElementById('msgInput');
        const hasText = msgInput && msgInput.value.trim().length > 0;
        const hasFiles = selectedFiles.length > 0;
        sendBtn.disabled = !hasText && !hasFiles;
        sendBtn.style.opacity = hasText || hasFiles ? '1' : '0.5';
        sendBtn.style.cursor = hasText || hasFiles ? 'pointer' : 'not-allowed';
      }
    }
  }

  /**
   * Render file chips above input field (like MessageInput.tsx)
   */
  function renderFileChips() {
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;

    const footer = host.shadowRoot.getElementById('chatFooter');
    if (!footer) {
      // Footer might not be ready yet, try again after a short delay
      setTimeout(renderFileChips, 100);
      return;
    }

    // Ensure footer is visible
    footer.classList.remove('hidden');

    // Remove existing chips container
    const existingChips = host.shadowRoot.getElementById('fileChipsContainer');
    if (existingChips) {
      existingChips.remove();
    }

    // If no files, don't render anything
    if (selectedFiles.length === 0) return;

    // Create chips container
    const chipsContainer = document.createElement('div');
    chipsContainer.id = 'fileChipsContainer';
    chipsContainer.className = 'file-chips-container';
    chipsContainer.style.display = 'flex';
    chipsContainer.style.flexWrap = 'wrap';
    chipsContainer.style.gap = '8px';
    chipsContainer.style.padding = '12px 16px';
    chipsContainer.style.borderBottom = '1px solid #e5e7eb';
    chipsContainer.style.backgroundColor = '#ffffff';
    chipsContainer.style.width = '100%';
    chipsContainer.style.boxSizing = 'border-box';

    selectedFiles.forEach((fileData, index) => {
      const chip = document.createElement('div');
      chip.style.display = 'flex';
      chip.style.alignItems = 'center';
      chip.style.gap = '8px';
      chip.style.height = '36px';
      chip.style.padding = '0 12px';
      chip.style.borderRadius = '6px';
      chip.style.backgroundColor = '#ffffff';
      chip.style.border = '1px solid #EFEFEF';
      chip.style.fontSize = '14px';
      chip.style.fontFamily =
        settings.appearance.fontFamily || 'DM Sans, sans-serif';
      chip.style.fontWeight = '400';
      chip.style.lineHeight = '20px';
      chip.style.color = '#18181E';

      // Determine icon based on file type (matching MessageInput.tsx)
      const lower = fileData.fileName.toLowerCase();
      const isPdf = lower.endsWith('.pdf');

      // Create icon element (using SVG like MessageInput.tsx uses Image component)
      const iconDiv = document.createElement('div');
      iconDiv.style.display = 'flex';
      iconDiv.style.alignItems = 'center';
      iconDiv.style.justifyContent = 'center';
      iconDiv.style.width = '20px';
      iconDiv.style.height = '20px';
      iconDiv.style.flexShrink = '0';

      // Use SVG icons (since we can't use Image component in vanilla JS)
      if (isPdf) {
        iconDiv.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
        </svg>`;
        iconDiv.style.color = settings.appearance.primaryColor;
      } else {
        iconDiv.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>`;
        iconDiv.style.color = settings.appearance.primaryColor;
      }

      // File name
      const nameSpan = document.createElement('span');
      nameSpan.style.overflow = 'hidden';
      nameSpan.style.textOverflow = 'ellipsis';
      nameSpan.style.whiteSpace = 'nowrap';
      nameSpan.style.maxWidth = '180px';
      nameSpan.textContent = fileData.fileName;

      // Remove button (matching MessageInput.tsx style)
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.style.display = 'flex';
      removeBtn.style.alignItems = 'center';
      removeBtn.style.justifyContent = 'center';
      removeBtn.style.padding = '4px';
      removeBtn.style.backgroundColor = 'transparent';
      removeBtn.style.border = 'none';
      removeBtn.style.cursor = 'pointer';
      removeBtn.style.borderRadius = '4px';
      removeBtn.style.flexShrink = '0';
      removeBtn.style.transition = 'background-color 0.2s';
      removeBtn.onmouseenter = () => {
        removeBtn.style.backgroundColor = '#f3f4f6';
      };
      removeBtn.onmouseleave = () => {
        removeBtn.style.backgroundColor = 'transparent';
      };
      removeBtn.onclick = () => removeSelectedFile(index);
      removeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>`;
      removeBtn.style.color = '#6b7280';

      chip.appendChild(iconDiv);
      chip.appendChild(nameSpan);
      chip.appendChild(removeBtn);
      chipsContainer.appendChild(chip);
    });

    // Insert chips container before input wrapper (inside footer)
    const inputWrapper = footer.querySelector('.chat-widget-input-wrapper');
    if (inputWrapper) {
      footer.insertBefore(chipsContainer, inputWrapper);
    } else {
      // If input wrapper not found, append to footer
      footer.insertBefore(chipsContainer, footer.firstChild);
    }

    // Ensure chips are visible
    chipsContainer.style.display = 'flex';
    chipsContainer.style.visibility = 'visible';
    chipsContainer.style.opacity = '1';
  }

  /**
   * Send all selected files with caption
   */
  async function sendSelectedFiles(caption) {
    if (selectedFiles.length === 0) return;

    // Get user details
    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === 'true';
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

    // Send each file
    const filesToSend = [...selectedFiles];
    const filesToCleanup = [...selectedFiles];

    // Clear selected files immediately
    selectedFiles.forEach((fileData) => {
      if (fileData.previewUrl) {
        URL.revokeObjectURL(fileData.previewUrl);
      }
    });
    selectedFiles = [];
    renderFileChips();

    for (const fileData of filesToSend) {
      const file = fileData.file;
      const mediaType = fileData.mediaType;
      const fileName = fileData.fileName;

      // Validate file size
      try {
        validateFileSize(file);
      } catch (error) {
        console.error('UniBox: File validation error', error);
        alert(error.message || 'File size exceeds limit');
        continue;
      }

      // Show uploading message
      const messageId = `msg_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;
      appendMessageToUI(
        'Uploading...',
        'user',
        messageId,
        new Date(),
        'sending',
        null,
        false,
        null,
        mediaType,
        null,
      );

      try {
        if (conversationId && !socket) {
          connectSocket();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // Convert file to base64
        const mediaBase64 = await fileToBase64(file);

        // Send media message
        const response = await fetch(`${API_BASE}/media/user`, {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({
            conversationId: conversationId || undefined,
            media_base64: mediaBase64,
            media_type: mediaType,
            userId: userId,
            userName: userDetails.userName,
            userEmail: userDetails.userEmail,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error?.message ||
              `Failed to send media: ${response.status}`,
          );
        }

        const result = await response.json();

        // Remove uploading message
        const host = document.getElementById('unibox-root');
        if (host && host.shadowRoot) {
          const body = host.shadowRoot.getElementById('chatBody');
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

        // Update conversation ID if this was a new conversation
        if (result.conversationId && !conversationId) {
          conversationId = result.conversationId;
          connectSocket();
        }

        // The message will be added via WebSocket, but we can also add it optimistically
        if (result.media_storage_url) {
          appendMessageToUI(
            caption || fileName,
            'user',
            result.messageId || messageId,
            result.timestamp || new Date(),
            result.status || 'sent',
            null,
            false,
            null,
            result.type || mediaType,
            result.media_storage_url,
          );
        }
      } catch (error) {
        console.error('UniBox: Send Media Error', error);

        // Update the uploading message to show error
        const host = document.getElementById('unibox-root');
        if (host && host.shadowRoot) {
          const body = host.shadowRoot.getElementById('chatBody');
          if (body) {
            const uploadingMsg = body.querySelector(
              `[data-message-id="${messageId}"]`,
            );
            if (uploadingMsg) {
              const content = uploadingMsg.querySelector(
                '.chat-widget-message-content',
              );
              if (content) {
                content.textContent = `Failed to upload: ${
                  error.message || 'Unknown error'
                }`;
                content.style.color = '#ef4444';
              }
            }
          }
        }

        // Show user-friendly error
        alert(error.message || 'Failed to upload media. Please try again.');
      }
    }
    // FIX: Sort messages after bulk sending
    sortMessagesByTimestamp();
  }

  /**
   * Add file to selected files (shows as chip above input)
   */
  async function sendMediaMessage(file) {
    // Validate file size first
    try {
      validateFileSize(file);
    } catch (error) {
      console.error('UniBox: File validation error', error);
      alert(error.message || 'File size exceeds limit');
      return;
    }

    // Add to selected files (will show as chip)
    addSelectedFile(file);
  }

  // --- UPDATED SEND MESSAGE FUNCTION WITH FIX ---
  async function sendMessageToApi(text) {
    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }

    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === 'true';
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.userName = storedName;
      if (storedEmail) userDetails.userEmail = storedEmail;
    }

    try {
      if (conversationId && !socket) {
        connectSocket();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const response = await fetch(`${API_BASE}/message/user`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          conversationId: conversationId || 'new',
          text: text,
          userId: userId,
          userName: userDetails.userName,
          userEmail: userDetails.userEmail,
          testMode: settings.testMode,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();

      if (result.conversationId && !conversationId) {
        conversationId = result.conversationId;
        connectSocket();
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const threadRes = await fetch(
            `${API_BASE}/thread/${userId}?limit=50`,
            {
              method: 'GET',
              headers: getHeaders(),
            },
          );
          if (threadRes.ok) {
            const threadData = await threadRes.json();
            if (threadData.messages && Array.isArray(threadData.messages)) {
              threadData.messages.forEach((msg) => {
                // Normalize text - convert empty string to null
                const textValue = msg.text || msg.text_body;
                const normalizedTextValue =
                  textValue && textValue.trim() ? textValue.trim() : null;

                appendMessageToUI(
                  normalizedTextValue,
                  msg.sender ||
                    (msg.direction === 'inbound' ? 'user' : 'agent'),
                  msg.id || msg.messageId,
                  msg.timestamp || msg.timestamp_meta,
                  msg.status,
                  msg.readAt,
                  msg.readByUs,
                  msg.readByUsAt,
                  msg.type,
                  msg.media_storage_url,
                );
              });
              // --- FIX: FORCE SORT HERE ---
              sortMessagesByTimestamp();
              markVisibleMessagesAsRead();
            }
          }
        } catch (e) {
          console.error('UniBox: Failed to fetch thread after message', e);
        }
      }

      return result;
    } catch (error) {
      console.error('UniBox: Send Error', error);
      const host = document.getElementById('unibox-root');
      if (host && host.shadowRoot) {
        const body = host.shadowRoot.getElementById('chatBody');
        if (body) {
          const errDiv = document.createElement('div');
          errDiv.style.textAlign = 'center';
          errDiv.style.fontSize = '12px';
          errDiv.style.color = 'red';
          errDiv.innerText = 'Failed to deliver message';
          body.appendChild(errDiv);
        }
      }
      throw error;
    }
  }

  /**
   * Show media preview in popup modal
   */
  async function showMediaPreview(mediaKey, mediaType, caption) {
    previewMedia = {
      mediaKey: mediaKey,
      mediaType: mediaType,
      caption: caption,
      url: null,
      filename: mediaKey.split('/').pop() || 'file',
      isLoading: true,
    };

    renderPreviewModal();

    // Fetch media URL
    try {
      const url = await fetchMediaUrl(mediaKey);
      if (url) {
        previewMedia.url = url;
        previewMedia.isLoading = false;
        renderPreviewModal();
      } else {
        throw new Error('Failed to load media');
      }
    } catch (error) {
      console.error('UniBox: Error loading media preview', error);
      previewMedia.isLoading = false;
      previewMedia.error = true;
      renderPreviewModal();
    }
  }

  /**
   * Render preview modal for file upload or media viewing
   */
  function renderPreviewModal() {
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;

    let modal = host.shadowRoot.getElementById('chatWidgetPreviewModal');

    // Remove existing modal
    if (modal) {
      modal.remove();
    }

    // Don't render if no preview (only for viewing received media)
    if (!previewMedia) return;

    // Create modal
    modal = document.createElement('div');
    modal.id = 'chatWidgetPreviewModal';
    modal.className = 'chat-widget-preview-modal';
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.right = '0';
    modal.style.bottom = '0';
    modal.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.style.zIndex = '2147483648';
    modal.onclick = (e) => {
      if (e.target === modal) {
        closePreviewModal();
      }
    };

    const modalContent = document.createElement('div');
    modalContent.className = 'chat-widget-preview-content';
    modalContent.style.backgroundColor = '#ffffff';
    modalContent.style.borderRadius = '12px';
    modalContent.style.padding = '20px';
    modalContent.style.maxWidth = '90vw';
    modalContent.style.maxHeight = '90vh';
    modalContent.style.overflow = 'auto';
    modalContent.style.position = 'relative';
    modalContent.style.boxShadow = '0 8px 30px rgba(0, 0, 0, 0.3)';
    modalContent.onclick = (e) => e.stopPropagation();

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.innerHTML = '&times;';
    closeBtn.style.position = 'absolute';
    closeBtn.style.top = '10px';
    closeBtn.style.right = '10px';
    closeBtn.style.width = '32px';
    closeBtn.style.height = '32px';
    closeBtn.style.border = 'none';
    closeBtn.style.backgroundColor = 'transparent';
    closeBtn.style.fontSize = '24px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.color = '#6b7280';
    closeBtn.style.borderRadius = '50%';
    closeBtn.style.display = 'flex';
    closeBtn.style.alignItems = 'center';
    closeBtn.style.justifyContent = 'center';
    closeBtn.onmouseenter = () => {
      closeBtn.style.backgroundColor = '#f3f4f6';
    };
    closeBtn.onmouseleave = () => {
      closeBtn.style.backgroundColor = 'transparent';
    };
    closeBtn.onclick = closePreviewModal;

    if (previewMedia) {
      const previewContainer = document.createElement('div');
      previewContainer.style.display = 'flex';
      previewContainer.style.flexDirection = 'column';
      previewContainer.style.gap = '16px';
      previewContainer.style.alignItems = 'center';

      if (previewMedia.isLoading) {
        const loadingDiv = document.createElement('div');
        loadingDiv.style.padding = '40px';
        loadingDiv.style.textAlign = 'center';
        loadingDiv.innerHTML = `
          <div style="width: 32px; height: 32px; border: 3px solid #e5e7eb; border-top-color: ${settings.appearance.primaryColor}; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 12px;"></div>
          <div style="color: #6b7280; font-size: 14px;">Loading media...</div>
        `;
        previewContainer.appendChild(loadingDiv);
      } else if (previewMedia.error) {
        const errorDiv = document.createElement('div');
        errorDiv.style.padding = '40px';
        errorDiv.style.textAlign = 'center';
        errorDiv.style.color = '#ef4444';
        errorDiv.innerHTML = `
          <div style="font-size: 14px;">Failed to load media</div>
        `;
        previewContainer.appendChild(errorDiv);
      } else if (previewMedia.url) {
        if (previewMedia.mediaType === 'image') {
          const img = document.createElement('img');
          img.src = previewMedia.url;
          img.style.maxWidth = '100%';
          img.style.maxHeight = '70vh';
          img.style.borderRadius = '8px';
          img.style.objectFit = 'contain';
          previewContainer.appendChild(img);
        } else if (previewMedia.mediaType === 'video') {
          const video = document.createElement('video');
          video.src = previewMedia.url;
          video.controls = true;
          video.style.maxWidth = '100%';
          video.style.maxHeight = '70vh';
          video.style.borderRadius = '8px';
          previewContainer.appendChild(video);
        } else if (previewMedia.mediaType === 'audio') {
          const audio = document.createElement('audio');
          audio.src = previewMedia.url;
          audio.controls = true;
          audio.style.width = '100%';
          previewContainer.appendChild(audio);
        } else {
          const fileLink = document.createElement('a');
          fileLink.href = previewMedia.url;
          fileLink.target = '_blank';
          fileLink.style.display = 'inline-block';
          fileLink.style.padding = '12px 20px';
          fileLink.style.backgroundColor = settings.appearance.primaryColor;
          fileLink.style.color = '#ffffff';
          fileLink.style.borderRadius = '6px';
          fileLink.style.textDecoration = 'none';
          fileLink.style.fontSize = '14px';
          fileLink.style.fontWeight = '500';
          fileLink.textContent = `Download ${previewMedia.filename}`;
          previewContainer.appendChild(fileLink);
        }

        if (previewMedia.caption) {
          const captionDiv = document.createElement('div');
          captionDiv.style.textAlign = 'center';
          captionDiv.style.color = '#6b7280';
          captionDiv.style.fontSize = '14px';
          captionDiv.style.marginTop = '8px';
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
    previewMedia = null;

    const host = document.getElementById('unibox-root');
    if (host && host.shadowRoot) {
      const modal = host.shadowRoot.getElementById('chatWidgetPreviewModal');
      if (modal) {
        modal.remove();
      }
    }
  }

  function formatTimestamp(timestamp, showReadReceipt = false) {
    if (!timestamp) return '';
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);

    if (showReadReceipt) {
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12;
      const hoursStr = hours.toString().padStart(2, '0');
      return `${hoursStr}:${minutes} ${ampm}`;
    }

    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    let hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const hoursStr = hours.toString().padStart(2, '0');
    const day = date.getDate();
    const month = date.toLocaleString('default', { month: 'short' });
    return `${day} ${month}, ${hoursStr}:${minutes} ${ampm}`;
  }

  function getReadReceiptIcon(status, readAt, readByUs, readByUsAt, sender) {
    // Logic disabled in original
    return '';
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
  ) {
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById('chatBody');
    if (!body) return;

    // Normalize text - handle null/undefined/empty string
    // Convert empty string to null for consistent handling
    const normalizedText = text && text.trim() ? text.trim() : null;

    // Prevent duplicate welcome messages: if static welcome is shown and this is a welcome message, skip it
    if (
      staticWelcomeShown &&
      type === 'agent' &&
      normalizedText &&
      isWelcomeMessage(normalizedText)
    ) {
      return;
    }

    const normalizedId = messageId || `msg_${Date.now()}`;
    const normalizedTimestamp = timestamp
      ? new Date(timestamp).getTime()
      : Date.now();

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
          const timeDiff = Math.abs(new Date(m.timestamp).getTime() - normalizedTimestamp);
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
                messages.set(messageId, m);

                // Update DOM attribute
                if (m.element) {
                    m.element.setAttribute('data-message-id', messageId);
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
      return;
    }

    const existingInDOM = Array.from(body.children).find((child) => {
      const childId = child.getAttribute('data-message-id');
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
          timestamp: timestamp || new Date(),
          status: status || 'sent',
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

    // CREATE MESSAGE ELEMENTS WITH NEW CLASSES
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-widget-message ${
      type === 'agent' ? 'bot' : 'user'
    }`;
    msgDiv.setAttribute('data-message-id', normalizedId);
    msgDiv.setAttribute('data-timestamp', normalizedTimestamp.toString());

    const msgContent = document.createElement('div');
    msgContent.className = 'chat-widget-message-content';

    // Handle media messages - show as chips/buttons instead of loading directly
    // Check if this is a media message (has type and media_storage_url)
    const isMediaMessage =
      messageType &&
      ['image', 'video', 'audio', 'document', 'file'].includes(messageType);
    const hasMedia =
      isMediaMessage && mediaStorageUrl && mediaStorageUrl.trim() !== '';

    // Ensure media messages are always rendered, even with empty/null text
    if (hasMedia) {
      // Show media as a clickable chip/button instead of loading directly
      const getMediaIcon = (type) => {
        if (type === 'image') {
          return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <circle cx="8.5" cy="8.5" r="1.5"></circle>
            <polyline points="21 15 16 10 5 21"></polyline>
          </svg>`;
        } else if (type === 'video') {
          return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="23 7 16 12 23 17 23 7"></polygon>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
          </svg>`;
        } else if (type === 'audio') {
          return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
          </svg>`;
        } else {
          return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
          </svg>`;
        }
      };

      const getMediaLabel = (type, textValue, mediaKey) => {
        // Use text if available and not an upload message
        if (
          textValue &&
          textValue !== 'Uploading...' &&
          !textValue.includes('Uploading')
        ) {
          return textValue;
        }
        // Extract filename from media key if available
        const fileName = mediaKey ? mediaKey.split('/').pop() : null;
        const labels = {
          image: 'Image',
          video: 'Video',
          audio: 'Audio',
          document: 'Document',
          file: 'File',
        };
        return fileName || labels[type] || 'Media';
      };

      const mediaChip = document.createElement('button');
      mediaChip.className = 'chat-widget-media-chip';
      mediaChip.type = 'button';
      mediaChip.style.display = 'flex';
      mediaChip.style.alignItems = 'center';
      mediaChip.style.gap = '8px';
      mediaChip.style.padding = '10px 12px';
      mediaChip.style.backgroundColor =
        type === 'agent' ? '#f5f7f9' : '#f9fafb';
      mediaChip.style.border = '1px solid #e5e7eb';
      mediaChip.style.borderRadius = '8px';
      mediaChip.style.cursor = 'pointer';
      mediaChip.style.transition = 'all 0.2s';
      mediaChip.style.width = '100%';
      mediaChip.style.textAlign = 'left';
      mediaChip.style.color = '#18181e';
      mediaChip.style.fontSize = '14px';
      mediaChip.style.fontFamily = settings.appearance.fontFamily;
      mediaChip.style.minHeight = '40px'; // Ensure minimum height for visibility
      mediaChip.onmouseenter = () => {
        mediaChip.style.backgroundColor =
          type === 'agent' ? '#e9ecef' : '#f3f4f6';
        mediaChip.style.transform = 'translateY(-1px)';
      };
      mediaChip.onmouseleave = () => {
        mediaChip.style.backgroundColor =
          type === 'agent' ? '#f5f7f9' : '#f9fafb';
        mediaChip.style.transform = 'translateY(0)';
      };
      mediaChip.onclick = () => {
        showMediaPreview(mediaStorageUrl, messageType, normalizedText);
      };

      const iconDiv = document.createElement('div');
      iconDiv.style.display = 'flex';
      iconDiv.style.alignItems = 'center';
      iconDiv.style.justifyContent = 'center';
      iconDiv.style.color = settings.appearance.primaryColor;
      iconDiv.style.flexShrink = '0';
      iconDiv.innerHTML = getMediaIcon(messageType);

      const labelDiv = document.createElement('div');
      labelDiv.style.flex = '1';
      labelDiv.style.minWidth = '0';
      labelDiv.style.wordBreak = 'break-word';
      labelDiv.textContent = getMediaLabel(
        messageType,
        normalizedText,
        mediaStorageUrl,
      );

      mediaChip.appendChild(iconDiv);
      mediaChip.appendChild(labelDiv);
      msgContent.appendChild(mediaChip);

      // Add text caption if available and not the file name
      if (
        normalizedText &&
        normalizedText !== 'Uploading...' &&
        !normalizedText.includes('Uploading') &&
        messageType !== 'document' &&
        messageType !== 'file'
      ) {
        const captionDiv = document.createElement('div');
        captionDiv.className = 'chat-widget-media-caption';
        captionDiv.textContent = normalizedText;
        captionDiv.style.marginTop = '8px';
        captionDiv.style.fontSize = '14px';
        captionDiv.style.lineHeight = '1.5';
        captionDiv.style.color = type === 'agent' ? '#18181e' : '#18181e';
        msgContent.appendChild(captionDiv);
      }

      // Store message data with media info
      if (normalizedId) {
        const messageData = {
          id: normalizedId,
          messageId: normalizedId,
          text: normalizedText,
          sender: type,
          timestamp: timestamp || new Date(),
          status: status || 'sent',
          readAt,
          readByUs: readByUs || false,
          readByUsAt,
          type: messageType,
          mediaStorageUrl: mediaStorageUrl,
          element: msgDiv,
        };
        messages.set(normalizedId, messageData);
      }

      msgDiv.appendChild(msgContent);
      body.appendChild(msgDiv);
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
        // Empty message with no media - don't render the message at all
        return; // Don't append empty messages
      }
    }

    // Only append if we have content (text or media)
    if (!hasMedia && !normalizedText) {
      return; // Safety check - don't render empty messages
    }

    msgDiv.appendChild(msgContent);

    const msgMeta = document.createElement('div');
    msgMeta.className = 'chat-widget-message-meta';

    // Only append meta if there is something inside, otherwise we get empty margin space
    if (msgMeta.hasChildNodes()) {
      msgDiv.appendChild(msgMeta);
    }

    // Store message data (for text messages only - media messages are stored above)
    if (!hasMedia && normalizedId) {
      const messageData = {
        id: normalizedId,
        messageId: normalizedId,
        text: normalizedText,
        sender: type,
        timestamp: timestamp || new Date(),
        status: status || 'sent',
        readAt,
        readByUs: readByUs || false,
        readByUsAt,
        type: messageType,
        mediaStorageUrl: mediaStorageUrl,
        element: msgDiv,
      };
      messages.set(normalizedId, messageData);
      if (messageId && normalizedId !== messageId) {
        messages.set(messageId, messageData);
      }
    }

    msgDiv.appendChild(msgContent);
    body.appendChild(msgDiv);
    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });
  }

  function sortMessagesByTimestamp() {
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById('chatBody');
    if (!body) return;

    const messageElements = Array.from(body.children).filter((child) => {
      return child.hasAttribute('data-timestamp');
    });

    messageElements.sort((a, b) => {
      const timestampA = parseInt(a.getAttribute('data-timestamp') || '0');
      const timestampB = parseInt(b.getAttribute('data-timestamp') || '0');
      return timestampA - timestampB;
    });

    messageElements.forEach((element) => {
      body.appendChild(element);
    });

    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });
  }

  function updateReadReceipt(receipt) {
    return;
  }

  async function markMessagesAsRead(messageIds) {
    if (!conversationId || !userId || settings.testMode) return;
    try {
      await fetch(`${API_BASE}/messages/read`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          conversationId: conversationId,
          userId: userId,
          messageIds: messageIds,
        }),
      });
    } catch (error) {
      console.error('UniBox: Failed to mark messages as read', error);
    }
  }

  function markVisibleMessagesAsRead() {
    if (!conversationId || !userId || settings.testMode) return;
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById('chatBody');
    if (!body) return;

    const unreadAgentMessages = Array.from(messages.values())
      .filter((msg) => {
        return msg.sender === 'agent' && (msg.status !== 'read' || !msg.readAt);
      })
      .map((msg) => msg.id || msg.messageId)
      .filter((id) => id);

    if (unreadAgentMessages.length > 0) {
      markMessagesAsRead(unreadAgentMessages);
    }
  }

  function updateOnlineStatus(isOnline, isAgent) {
    if (isAgent) {
      isAgentOnline = isOnline;
      updateOnlineStatusIndicator();
    }
  }

  function updateOnlineStatusIndicator() {
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;
    const statusIndicator = host.shadowRoot.getElementById(
      'onlineStatusIndicator',
    );
    if (statusIndicator) {
      statusIndicator.textContent = isAgentOnline ? '● Online' : '○ Offline';
      statusIndicator.className = `chat-widget-online-status ${
        isAgentOnline ? 'online' : 'offline'
      }`;
    }
  }

  function showTypingIndicator(show) {
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;
    const typingIndicator = host.shadowRoot.getElementById('typingIndicator');
    if (typingIndicator) {
      if (show) {
        typingIndicator.classList.remove('hidden');
        const body = host.shadowRoot.getElementById('chatBody');
        if (body) {
          requestAnimationFrame(() => {
            body.scrollTop = body.scrollHeight;
          });
        }
      } else {
        typingIndicator.classList.add('hidden');
      }
    }
  }

  function emitTypingStatus(typing) {
    if (!socket || !conversationId || !userId || !socket.connected) return;
    socket.emit('typing', {
      conversationId: conversationId,
      userId: userId,
      isTyping: typing,
      isAgent: false,
    });
  }

  // --- 10. UI RENDERING ---
  function renderWidget() {
    const host = document.createElement('div');
    host.id = 'unibox-root';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    // Styles variables calculation
    // Force white background if a logo image is used
    let launcherBg =
      settings.appearance.chatToggleIcon.backgroundColor ||
      settings.appearance.primaryColor;

    if (resolvedLogoUrl) {
      launcherBg = '#FFFFFF';
    }

    const launcherIconColor =
      launcherBg.toLowerCase() === '#ffffff' ||
      launcherBg.toLowerCase() === '#fff'
        ? settings.appearance.primaryColor
        : '#FFFFFF';

    const placement = settings.behavior.stickyPlacement || 'bottom-right';
    const isTop = placement.includes('top');
    const isRight = placement.includes('right');
    const horizontalCss = isRight ? 'right: 20px;' : 'left: 20px;';
    const verticalLauncherCss = isTop ? 'top: 20px;' : 'bottom: 20px;';
    const verticalWindowCss = isTop ? 'top: 90px;' : 'bottom: 90px;';

    const getRadius = (style) => {
      if (style === 'rounded') return '12px';
      if (style === 'square') return '0px';
      return '50%';
    };
    const launcherRadius = getRadius(settings.appearance.chatToggleIcon.style);
    const headerLogoRadius =
      settings.appearance.iconStyle === 'round' ? '50%' : '8px';

    const styleTag = document.createElement('style');

    // Updated CSS to match the provided JSX UI exactly
    styleTag.textContent = `
        :host {
          font-family: ${settings.appearance.fontFamily} !important;
        }
        
        /* Note: Container set to fixed to ensure it floats above page content as a widget */
        .chat-widget-container {
          position: fixed; z-index: 2147483647; 
          top: auto; bottom: auto; left: auto; right: auto;
          width: 0; height: 0;
          font-family: ${settings.appearance.fontFamily};
          display: block;
        }

        .chat-widget-container *,
        .chat-widget-header,
        .chat-widget-header *,
        .chat-widget-body,
        .chat-widget-body *,
        .chat-widget-footer,
        .chat-widget-footer *,
        .chat-widget-input,
        .chat-widget-form-input,
        .chat-widget-form-btn {
          font-family: ${settings.appearance.fontFamily} !important;
          box-sizing: border-box;
        }

        .chat-widget-launcher {
          position: fixed; ${verticalLauncherCss} ${horizontalCss}
          width: 60px;
          height: 60px;
          background: ${launcherBg};
          color: ${launcherIconColor};
          border-radius: ${launcherRadius};
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.15);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.2s;
          overflow: hidden;
          z-index: 2147483647;
        }

        .chat-widget-launcher:hover {
          transform: scale(1.05);
        }

        .chat-widget-window {
          position: fixed; ${verticalWindowCss} ${horizontalCss}
          width: 380px;
          height: 600px;
          max-width: calc(100vw - 40px);
          max-height: calc(100vh - 120px);
          background: #ffffff;
          border-radius: 12px;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          opacity: 0;
          pointer-events: none;
          transform: ${
            isTop ? 'translateY(-20px)' : 'translateY(20px)'
          } scale(0.95);
          transition: all 0.25s ease;
          border: 1px solid rgba(0, 0, 0, 0.05);
          z-index: 2147483647;
        }

        .chat-widget-window.open {
          opacity: 1;
          pointer-events: auto;
          transform: translateY(0) scale(1);
        }

        .chat-widget-header {
          background: ${settings.appearance.primaryColor};
          padding: 16px;
          color: #fff;
          display: flex;
          align-items: center;
          gap: 12px;
          flex-shrink: 0;
        }

        .chat-widget-header-logo {
          width: 32px;
          height: 32px;
          border-radius: ${headerLogoRadius};
          background: #fff;
          padding: 2px;
          object-fit: cover;
        }

        .chat-widget-header-title {
          font-weight: 600;
          font-size: 16px;
          flex: 1;
        }

        .chat-widget-online-status {
          font-size: 12px;
          margin-left: 8px;
          display: flex;
          align-items: center;
          gap: 4px;
          font-weight: 400;
          height: 10px;
          line-height: 10px;
        }

        .chat-widget-online-status.online {
          color: #22c55e;
        }

        .chat-widget-online-status.offline {
          color: #9da2ab;
        }

        .chat-widget-body {
          flex: 1;
          padding: 24px;
          overflow-y: auto;
          background-color: #fafbfc;
          position: relative;
        }

        .chat-widget-loader {
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100%;
        }

        .chat-widget-loader-spinner {
          border: 3px solid #f3f3f3;
          border-top: 3px solid ${settings.appearance.primaryColor};
          border-radius: 50%;
          width: 24px;
          height: 24px;
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
          max-width: 85%;
          margin-bottom: 12px;
          display: flex;
          flex-direction: column;
        }

        .chat-widget-message.bot {
          align-self: flex-start;
        }

        .chat-widget-message.user {
          align-self: flex-end;
          margin-left: auto;
        }

        .chat-widget-message-content {
          padding: 14px 16px;
          border-radius: 10px;
          font-size: 14px;
          line-height: 1.43;
          word-break: break-word;
          font-weight: 400;
        }

        .chat-widget-message.bot .chat-widget-message-content {
          background: ${settings.appearance.secondaryColor};
          color: #18181e;
          border-radius: 10px;
          border-top-left-radius: 0;
        }

        .chat-widget-message.user .chat-widget-message-content {
          background: ${settings.appearance.backgroundColor};
          color: #18181e;
          border-radius: 10px;
          border-bottom-right-radius: 0;
        }

        .chat-widget-message-meta {
          display: flex;
          align-items: center;
          gap: 4px;
          margin-top: 8px;
          font-size: 12px;
          justify-content: flex-end;
        }

        .chat-widget-message.user .chat-widget-message-meta {
          justify-content: flex-end;
        }

        .chat-widget-message.bot .chat-widget-message-meta {
          justify-content: flex-start;
        }

        .chat-widget-message-time {
          color: #18181e;
          font-size: 12px;
          font-weight: 400;
          line-height: 16px;
        }

        .chat-widget-read-receipt {
          display: inline-flex;
          align-items: center;
          margin-right: 4px;
        }
        
        .chat-widget-read-receipt-icon {
          display: inline-block;
          vertical-align: middle;
          flex-shrink: 0;
        }

        .chat-widget-typing-indicator {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 14px 16px;
          background: #f5f7f9;
          border-radius: 10px;
          border-top-left-radius: 0;
          margin: 8px 0;
          max-width: 80px;
          align-self: flex-start;
        }

        .chat-widget-typing-indicator.hidden {
          display: none;
        }

        .chat-widget-typing-dot {
          width: 8px;
          height: 8px;
          background: #9ca3af;
          border-radius: 50%;
          animation: typing 1.4s infinite;
        }

        .chat-widget-typing-dot:nth-child(2) {
          animation-delay: 0.2s;
        }

        .chat-widget-typing-dot:nth-child(3) {
          animation-delay: 0.4s;
        }

        @keyframes typing {
          0%,
          60%,
          100% {
            transform: translateY(0);
            opacity: 0.7;
          }
          30% {
            transform: translateY(-10px);
            opacity: 1;
          }
        }

        .chat-widget-form-container {
          display: flex;
          flex-direction: column;
          gap: 15px;
          background: #ffffff;
          padding: 24px;
          border-radius: 8px;
        }

        .chat-widget-form-input {
          width: 100%;
          padding: 10px;
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          font-size: 14px;
        }

        .chat-widget-form-input:focus {
          outline: none;
          border-color: ${settings.appearance.primaryColor};
        }

        .chat-widget-form-btn {
          width: 100%;
          padding: 12px;
          background: ${settings.appearance.primaryColor};
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
        }

        .chat-widget-footer {
          padding: 12px;
          background: #ffffff;
          border-top: 1px solid #eee;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }

        .chat-widget-footer.hidden {
          display: none;
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
          background: #f3f4f6;
          border-radius: 20px;
          padding: 8px 12px;
          gap: 8px;
        }

        .chat-widget-attach-btn {
          background: transparent;
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #6b7280;
          padding: 4px;
          border-radius: 4px;
          transition: background 0.2s;
        }

        .chat-widget-attach-btn:hover {
          background: rgba(0, 0, 0, 0.05);
        }

        .chat-widget-input {
          flex: 1;
          border: none;
          background: transparent;
          outline: none;
          font-size: 14px;
          color: #1f2937;
        }

        .chat-widget-send-btn {
          background: ${settings.appearance.primaryColor};
          color: white;
          border: none;
          width: 36px;
          height: 36px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
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
          transition: all 0.2s ease;
          min-height: 40px;
          display: flex !important;
          visibility: visible !important;
        }

        .chat-widget-media-chip:hover {
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
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

    const chatIcon = `<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>`;

    const container = document.createElement('div');
    container.className = 'chat-widget-container';

    const headerLogoImg = resolvedLogoUrl
      ? `<img src="${resolvedLogoUrl}" class="chat-widget-header-logo" alt="Logo" />`
      : '';

    const launcherContent = resolvedLogoUrl
      ? `<img src="${resolvedLogoUrl}" style="width: 100%; height: 100%; object-fit: cover;" alt="Chat" />`
      : chatIcon;

    container.innerHTML = `
      <div class="chat-widget-launcher" id="launcherBtn">${launcherContent}</div>
      <div class="chat-widget-window" id="chatWindow">
        <div class="chat-widget-header">
           ${headerLogoImg}
           <div style="flex: 1;">
             <div class="chat-widget-header-title">${
               settings.appearance.header?.title ||
               settings.appearance.headerName
             }</div>
             <div id="onlineStatusIndicator" class="chat-widget-online-status offline">○ Offline</div>
           </div>
           <div id="closeBtn" style="cursor:pointer; font-size:24px; opacity:0.8; line-height: 1;">&times;</div>
        </div>
        <div class="chat-widget-body" id="chatBody">
          <div class="chat-widget-typing-indicator hidden" id="typingIndicator">
            <div class="chat-widget-typing-dot"></div>
            <div class="chat-widget-typing-dot"></div>
            <div class="chat-widget-typing-dot"></div>
          </div>
        </div>
        <div class="chat-widget-footer hidden" id="chatFooter">
           <div class="chat-widget-input-wrapper">
             <input type="file" id="fileInput" style="display: none;" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx" multiple />
             <button class="chat-widget-attach-btn" id="attachBtn" title="Attach file">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                 <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
               </svg>
             </button>
             <input type="text" class="chat-widget-input" id="msgInput" placeholder="Type a message..." />
           </div>
           <button class="chat-widget-send-btn" id="sendBtn">
             <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
           </button>
        </div>
      </div>
    `;

    shadow.appendChild(styleTag);
    shadow.appendChild(container);

    // --- 11. VIEW LOGIC ---
    const isFormEnabled = settings.preChatForm.enabled;
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === 'true';
    let currentView = isFormEnabled && !hasSubmittedForm ? 'form' : 'chat';

    const renderView = () => {
      const body = shadow.getElementById('chatBody');
      const footer = shadow.getElementById('chatFooter');
      body.innerHTML = '';

      // Re-add typing indicator to body (it gets cleared)
      body.innerHTML = `
        <div class="chat-widget-typing-indicator hidden" id="typingIndicator">
            <div class="chat-widget-typing-dot"></div>
            <div class="chat-widget-typing-dot"></div>
            <div class="chat-widget-typing-dot"></div>
        </div>
      `;

      if (currentView === 'form') {
        footer.classList.add('hidden');

        const fieldsHtml = settings.preChatForm.fields
          .map((f) => {
            let inputHtml = '';
            const isRequired = f.required ? 'required' : '';

            if (f.type === 'textarea') {
              inputHtml = `<textarea class="chat-widget-form-input" name="${f.id}" ${isRequired} placeholder="${f.label}"></textarea>`;
            } else {
              const inputType = f.type === 'phone' ? 'tel' : f.type;
              inputHtml = `<input class="chat-widget-form-input" type="${inputType}" name="${f.id}" ${isRequired} placeholder="${f.label}">`;
            }

            return `
            <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px;">${f.label}${
              f.required ? ' <span style="color:red">*</span>' : ''
            }</label>
              ${inputHtml}
            </div>
          `;
          })
          .join('');

        const formContainer = document.createElement('div');
        formContainer.className = 'chat-widget-form-container';
        formContainer.innerHTML = `
          <div style="text-align:center; margin-bottom:5px; font-weight:600; font-size:16px; color:#111;">Welcome</div>
          <div style="text-align:center; margin-bottom:20px; font-size:14px; color:#666;">Please fill in your details to continue.</div>
          <form id="preChatForm">
            ${fieldsHtml}
            <button type="submit" class="chat-widget-form-btn">Start Chat</button>
          </form>
        `;
        body.appendChild(formContainer);

        const formEl = formContainer.querySelector('#preChatForm');
        formEl.addEventListener('submit', (e) => {
          e.preventDefault();
          const formData = new FormData(formEl);
          const data = Object.fromEntries(formData.entries());

          let capturedName = '';
          let capturedEmail = '';

          settings.preChatForm.fields.forEach((field) => {
            const val = data[field.id];
            if (!val) return;
            if (
              field.type === 'text' &&
              (field.label.toLowerCase().includes('name') ||
                field.id.toLowerCase().includes('name'))
            )
              capturedName = val;
            if (
              field.type === 'email' ||
              field.id.toLowerCase().includes('email')
            )
              capturedEmail = val;
          });

          if (!capturedName && capturedEmail) capturedName = capturedEmail;

          sessionStorage.setItem(SESSION_KEY_FORM, 'true');
          if (capturedName)
            sessionStorage.setItem(`${SESSION_KEY_FORM}_name`, capturedName);
          if (capturedEmail)
            sessionStorage.setItem(`${SESSION_KEY_FORM}_email`, capturedEmail);

          currentView = 'chat';
          renderView();
        });
      } else {
        footer.classList.remove('hidden');

        // Re-render file chips if there are selected files
        if (selectedFiles.length > 0) {
          setTimeout(() => renderFileChips(), 50);
        }

        // Show welcome message if not already shown and no messages exist
        if (!staticWelcomeShown) {
          const welcomeText =
            settings.appearance.header?.welcomeMessage ||
            settings.appearance.welcomeMessage;
          if (welcomeText) {
            // Check if there are any existing messages
            const hasMessages = Array.from(messages.values()).length > 0;
            if (!hasMessages) {
              appendMessageToUI(
                welcomeText,
                'agent',
                `static_welcome_${Date.now()}`,
                new Date(),
                'sent',
                null,
                false,
                null,
                'text',
                undefined,
              );
              staticWelcomeShown = true;
            }
          }
        }
      }
    };

    renderView();

    // --- 12. EVENTS ---
    const launcher = shadow.getElementById('launcherBtn');
    const windowEl = shadow.getElementById('chatWindow');
    const closeBtn = shadow.getElementById('closeBtn');
    const sendBtn = shadow.getElementById('sendBtn');
    const msgInput = shadow.getElementById('msgInput');
    const attachBtn = shadow.getElementById('attachBtn');
    const fileInput = shadow.getElementById('fileInput');

    const toggle = (forceState) => {
      const isOpen = windowEl.classList.contains('open');
      const nextState = forceState !== undefined ? forceState : !isOpen;

      if (nextState) windowEl.classList.add('open');
      else windowEl.classList.remove('open');

      if (settings.behavior.stickyPlacement) {
        localStorage.setItem(STORAGE_KEY_OPEN, nextState);
      }
    };

    launcher.addEventListener('click', () => toggle());
    closeBtn.addEventListener('click', () => toggle(false));

    const handleSend = () => {
      const text = msgInput.value.trim();

      // If there are selected files, send them with caption
      if (selectedFiles.length > 0) {
        sendSelectedFiles(text || undefined).catch((err) => {
          console.error('UniBox: Failed to send media', err);
        });
        msgInput.value = '';
        return;
      }

      // Otherwise send text message
      if (!text) return;

      msgInput.value = '';

      const messageId = `msg_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;
      appendMessageToUI(
        text,
        'user',
        messageId,
        new Date(),
        'sent',
        null,
        false,
        null,
        'text',
        null,
      );

      sendMessageToApi(text).catch((err) => {
        console.error('UniBox: Failed to send message', err);
      });
    };

    attachBtn.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        files.forEach((file) => {
          sendMediaMessage(file).catch((err) => {
            console.error('UniBox: Failed to add media file', err);
          });
        });
        fileInput.value = ''; // Reset input
      }
    });

    sendBtn.addEventListener('click', handleSend);
    msgInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
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
      sendBtn.style.opacity = hasText || hasFiles ? '1' : '0.5';
      sendBtn.style.cursor = hasText || hasFiles ? 'pointer' : 'not-allowed';
    };

    msgInput.addEventListener('input', updateSendButtonState);
    updateSendButtonState();

    // Re-render chips when footer becomes visible (in case it was hidden)
    const observer = new MutationObserver(() => {
      if (selectedFiles.length > 0) {
        renderFileChips();
        updateSendButtonState();
      }
    });

    // NOTE: `footer` is defined inside `renderView` and not in this scope.
    // To avoid ReferenceError and still react to footer changes, we resolve
    // the footer element here via the shadow root before observing.
    const footerEl = shadow.getElementById('chatFooter');
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

    async function markContactAsRead() {
      if (!userId || settings.testMode) return;
      try {
        await fetch(`${API_BASE}/read/${userId}`, {
          method: 'POST',
          headers: getHeaders(),
        });
      } catch (error) {
        console.error('UniBox: Failed to mark contact as read', error);
      }
    }

    const chatWindow = shadow.getElementById('chatWindow');
    const chatBody = shadow.getElementById('chatBody');
    if (chatBody) {
      let scrollTimeout;
      chatBody.addEventListener('scroll', () => {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          markVisibleMessagesAsRead();
        }, 500);
      });

      const observer = new MutationObserver(() => {
        if (chatWindow.classList.contains('open')) {
          markContactAsRead();
          markVisibleMessagesAsRead();
        }
      });
      observer.observe(chatWindow, {
        attributes: true,
        attributeFilter: ['class'],
      });

      if (chatWindow.classList.contains('open')) {
        setTimeout(() => {
          markContactAsRead();
          markVisibleMessagesAsRead();
        }, 500);
      }
    }

    if (settings.behavior.autoOpen) {
      const hasHistory = localStorage.getItem(STORAGE_KEY_OPEN);
      if (hasHistory === null || hasHistory === 'true') {
        const delay = settings.behavior.autoOpenDelay || 2000;
        setTimeout(() => toggle(true), delay);
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

  function loadGoogleFont(font) {
    if (!font) return;
    const family = font.split(',')[0].replace(/['"]/g, '').trim();
    if (['sans-serif', 'serif', 'system-ui'].includes(family.toLowerCase()))
      return;
    const link = document.createElement('link');
    link.href = `https://fonts.googleapis.com/css2?family=${family.replace(
      / /g,
      '+',
    )}:wght@400;500;600&display=swap`;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
})();
