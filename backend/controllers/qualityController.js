class QualityController {
  constructor(
    qualityService,
    db,
    telegramService = null,
    contactService = null,
    accountService = null,
    chatLogService = null,
    settingsService = null
  ) {
    this.qualityService = qualityService;
    this.db = db;
    this.telegramService = telegramService;
    this.contactService = contactService;
    this.accountService = accountService;
    this.chatLogService = chatLogService;
    this.settingsService = settingsService;
    this.personalAccountKey = process.env.PERSONAL_ACCOUNT_KEY || 'personal-account';
    this.botAccountKey = process.env.BOT_ACCOUNT_KEY || 'bot-account';
  }

  getCurrent = async (req, res) => {
    try {
      const snapshot = this.qualityService.getCurrentSnapshot();

      if (!snapshot) {
        return res.status(503).json({
          success: false,
          error: 'Quality data not available yet. Please try again shortly.',
        });
      }

      const emergency = this.qualityService.getEmergencyState();

      res.json({
        success: true,
        snapshot,
        emergency,
      });
    } catch (error) {
      console.error('❌ Error in QualityController.getCurrent:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch current quality data',
      });
    }
  };

  sendTelegramSummary = async (req, res) => {
    try {
      const { chatId = null } = req.body || {};
      const result = await this.qualityService.sendTelegramSummary({ chatId });
      res.json({
        success: Boolean(result?.ok),
        result,
      });
    } catch (error) {
      console.error('❌ Error in QualityController.sendTelegramSummary:', error.message);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to send Telegram summary',
      });
    }
  };

  getTtlHistory = async (req, res) => {
    try {
      const { proxyPort, limit = 24 } = req.query;
      const limitNum = Math.min(Math.max(parseInt(limit, 10) || 24, 1), 168); // up to 7 days hourly

      const params = [limitNum];
      let whereClause = '';

      if (proxyPort) {
        const proxyPortNum = parseInt(proxyPort, 10);
        if (Number.isNaN(proxyPortNum)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid proxyPort',
          });
        }
        whereClause = 'WHERE proxy_port = ?';
        params.unshift(proxyPortNum);
      }

      const query = `
        SELECT 
          window_start,
          window_end,
          SUM(sample_count) AS sample_count,
          SUM(success_count) AS success_count,
          SUM(timeout_count) AS timeout_count,
          SUM(CASE WHEN quality = 'bad' THEN 1 ELSE 0 END) AS bad_targets,
          SUM(CASE WHEN quality = 'warning' THEN 1 ELSE 0 END) AS warning_targets,
          SUM(CASE WHEN quality = 'good' THEN 1 ELSE 0 END) AS good_targets
        FROM ttl_quality_snapshots
        ${whereClause}
        GROUP BY window_start, window_end
        ORDER BY window_start DESC
        LIMIT ?
      `;

      const [rows] = await this.db.execute(query, params);

      const history = rows.map((row) => ({
        windowStart: row.window_start ? new Date(row.window_start).toISOString() : null,
        windowEnd: row.window_end ? new Date(row.window_end).toISOString() : null,
        sampleCount: Number(row.sample_count) || 0,
        successCount: Number(row.success_count) || 0,
        timeoutCount: Number(row.timeout_count) || 0,
        badTargets: Number(row.bad_targets) || 0,
        warningTargets: Number(row.warning_targets) || 0,
        goodTargets: Number(row.good_targets) || 0,
      }));

      res.json({
        success: true,
        history,
      });
    } catch (error) {
      console.error('❌ Error in QualityController.getTtlHistory:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch TTL history',
      });
    }
  };

  getDailyAnalysis = async (req, res) => {
    try {
      const { date = null, proxyPort } = req.query;
      let portFilter = null;

      if (proxyPort !== undefined) {
        const parsedPort = parseInt(proxyPort, 10);
        if (Number.isNaN(parsedPort)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid proxyPort',
          });
        }
        portFilter = parsedPort;
      }

      const analysis = await this.qualityService.analyzeDailyQuality({
        date,
        proxyPort: portFilter,
      });

      res.json({
        success: true,
        ...analysis,
      });
    } catch (error) {
      if (error && error.message === 'Invalid proxyPort') {
        return res.status(400).json({
          success: false,
          error: 'Invalid proxyPort',
        });
      }

      console.error('❌ Error in QualityController.getDailyAnalysis:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to analyze daily quality',
      });
    }
  };

  getBandwidthHistory = async (req, res) => {
    try {
      const { proxyPort, limit = 24 } = req.query;
      const limitNum = Math.min(Math.max(parseInt(limit, 10) || 24, 1), 168);

      const params = [limitNum];
      let whereClause = '';

      if (proxyPort) {
        const proxyPortNum = parseInt(proxyPort, 10);
        if (Number.isNaN(proxyPortNum)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid proxyPort',
          });
        }
        whereClause = 'WHERE proxy_port = ?';
        params.unshift(proxyPortNum);
      }

      const query = `
        SELECT 
          window_start,
          window_end,
          SUM(sample_count) AS sample_count,
          AVG(avg_bandwidth_mbps) AS avg_bandwidth,
          SUM(CASE WHEN quality = 'bad' THEN 1 ELSE 0 END) AS bad_ips,
          SUM(CASE WHEN quality = 'warning' THEN 1 ELSE 0 END) AS warning_ips,
          SUM(CASE WHEN quality = 'good' THEN 1 ELSE 0 END) AS good_ips
        FROM bandwidth_quality_snapshots
        ${whereClause}
        GROUP BY window_start, window_end
        ORDER BY window_start DESC
        LIMIT ?
      `;

      const [rows] = await this.db.execute(query, params);

      const history = rows.map((row) => ({
        windowStart: row.window_start ? new Date(row.window_start).toISOString() : null,
        windowEnd: row.window_end ? new Date(row.window_end).toISOString() : null,
        sampleCount: Number(row.sample_count) || 0,
        avgBandwidth: row.avg_bandwidth !== null ? Number(row.avg_bandwidth) : null,
        badIps: Number(row.bad_ips) || 0,
        warningIps: Number(row.warning_ips) || 0,
        goodIps: Number(row.good_ips) || 0,
      }));

      res.json({
        success: true,
        history,
      });
    } catch (error) {
      console.error('❌ Error in QualityController.getBandwidthHistory:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch bandwidth history',
      });
    }
  };

  receiveExternalAlert = async (req, res) => {
    try {
      const expectedToken = process.env.EXTERNAL_ALERT_TOKEN;
      if (!expectedToken) {
        return res.status(503).json({
          success: false,
          error: 'External alerts disabled (EXTERNAL_ALERT_TOKEN missing)',
        });
      }

      const authHeader = req.headers.authorization || '';
      const providedToken = authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length)
        : null;

      if (!providedToken || providedToken !== expectedToken) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
      }

      const {
        chat_id: chatId,
        chat_title: chatTitle,
        sender_username: senderUsername,
        sender_name: senderName,
        message,
        has_media: hasMedia = false,
        account_id: accountIdInput,
        account_key: accountKey,
        date: messageDate = null,
      } = req.body || {};

      if (!message) {
        return res.status(400).json({
          success: false,
          error: 'Message payload required',
        });
      }

      let accountId = null;
      if (this.accountService) {
        if (accountIdInput) {
          const account = await this.accountService.getAccountById(accountIdInput);
          if (account) {
            accountId = account.id;
          }
        }
        if (!accountId && accountKey) {
          const account = await this.accountService.getAccountByKey(accountKey);
          if (account) {
            accountId = account.id;
          }
        }
        if (!accountId) {
          const accounts = await this.accountService.listAccounts();
          const personal = accounts.find((acc) => acc.type === 'personal') || accounts[0];
          if (personal) {
            accountId = personal.id;
          }
        }
      }

      let matchedContact = null;
      if (this.contactService) {
        matchedContact = await this.contactService.findContactByChat({
          accountId,
          telegramChatId: chatId,
          telegramUsername: senderUsername,
        });
      }

      if (
        this.settingsService &&
        this.telegramService &&
        typeof this.telegramService.isEnabled === 'function' &&
        this.telegramService.isEnabled() &&
        this.contactService &&
        accountId
      ) {
        try {
          const notifyForwardEnabled = await this.settingsService.getBoolean('notify_forwarding_enabled', false);
          const matchedRole = matchedContact?.role ? matchedContact.role.toLowerCase() : '';
          if (notifyForwardEnabled && matchedRole.includes('important')) {
            const notifyTargets = await this.contactService.listContacts({
              accountId,
              role: 'notify target',
            });
            if (notifyTargets && notifyTargets.length > 0) {
              const escapedHi =
                this.telegramService.constructor && typeof this.telegramService.constructor.escape === 'function'
                  ? this.telegramService.constructor.escape('hi.')
                  : 'hi.';
              await Promise.all(
                notifyTargets.map(async (target) => {
                  const normalizedUsername = target.telegramUsername
                    ? target.telegramUsername.startsWith('@')
                      ? target.telegramUsername
                      : `@${target.telegramUsername}`
                    : null;
                  const targetChat = target.telegramChatId ? target.telegramChatId : normalizedUsername;
                  if (!targetChat) {
                    return;
                  }
                  if (
                    chatId &&
                    target.telegramChatId &&
                    String(target.telegramChatId) === String(chatId)
                  ) {
                    return;
                  }
                  await this.telegramService.sendToChat(targetChat, escapedHi, {
                    parseMode: 'MarkdownV2',
                    contactId: target.id,
                    chatTitle: target.name || chatTitle || null,
                  });
                })
              );
            }
          }
        } catch (notifyError) {
          console.error('⚠️ Failed to execute notify forwarding:', notifyError.message);
        }
      }

      if (this.chatLogService && accountId) {
        try {
          await this.chatLogService.recordMessage({
            accountId,
            contactId: matchedContact ? matchedContact.id : null,
            chatId: chatId || null,
            chatTitle: chatTitle || null,
            senderUsername: senderUsername || null,
            senderDisplay: senderName || (matchedContact ? matchedContact.name : senderUsername) || null,
            direction: 'incoming',
            message,
            hasMedia: Boolean(hasMedia),
            payload: req.body,
            occurredAt: messageDate || new Date(),
          });
        } catch (error) {
          console.error('⚠️ Failed to record chat message:', error.message);
        }
      }

      res.json({ success: true });
    } catch (error) {
      console.error('❌ Error handling external alert:', error && error.stack ? error.stack : error);
      res.status(500).json({
        success: false,
        error: 'Failed to process alert',
      });
    }
  };

  sendDailyAnalysis = async (req, res) => {
    try {
      const { date = null, proxyPort = null } = req.body || {};

      if (!this.telegramService || !this.telegramService.isEnabled()) {
        return res.status(503).json({
          success: false,
          error: 'Telegram notifications are disabled',
        });
      }

      let botAccountId = null;
      if (this.accountService) {
        const botAccount = await this.accountService.getAccountByKey(this.botAccountKey);
        botAccountId = botAccount ? botAccount.id : null;
      }

      const targetRoles = ['boss', 'me', 'self'];
      const recipients = [];
      const seenKeys = new Set();
      if (this.contactService) {
        for (const role of targetRoles) {
          const roleContacts = await this.contactService.listContacts({
            accountId: botAccountId || undefined,
            role,
          });
          roleContacts.forEach((contact) => {
            if (!contact.telegramChatId && !contact.telegramUsername) {
              return;
            }
            const normalizedUsername = contact.telegramUsername
              ? contact.telegramUsername.startsWith('@')
                ? contact.telegramUsername
                : `@${contact.telegramUsername}`
              : null;
            const key = contact.telegramChatId || normalizedUsername;
            if (seenKeys.has(key)) {
              return;
            }
            seenKeys.add(key);
            recipients.push({
              contactId: contact.id,
              chatId: contact.telegramChatId || null,
              username: normalizedUsername,
              name: contact.name || contact.telegramUsername || contact.telegramChatId || 'Boss',
            });
          });
        }

        if (recipients.length === 0) {
          for (const role of targetRoles) {
            const fallbackContacts = await this.contactService.listContacts({ role });
            fallbackContacts.forEach((contact) => {
              if (!contact.telegramChatId && !contact.telegramUsername) {
                return;
              }
              const normalizedUsername = contact.telegramUsername
                ? contact.telegramUsername.startsWith('@')
                  ? contact.telegramUsername
                  : `@${contact.telegramUsername}`
                : null;
              const key = contact.telegramChatId || normalizedUsername;
              if (seenKeys.has(key)) {
                return;
              }
              seenKeys.add(key);
              recipients.push({
                contactId: contact.id,
                chatId: contact.telegramChatId || null,
                username: normalizedUsername,
                name: contact.name || contact.telegramUsername || contact.telegramChatId || 'Boss',
              });
            });
            if (recipients.length > 0) {
              break;
            }
          }
        }
      }

      const uniqueRecipients = [];
    recipients.forEach((recipient) => {
      const key = recipient.chatId || recipient.username;
      if (!key) {
        return;
      }
      uniqueRecipients.push(recipient);
    });

      const result = await this.qualityService.sendDailyAnalysisReport({
        date,
        proxyPort,
        recipients: uniqueRecipients,
      });

      res.json({
        success: Boolean(result.ok),
        analysis: result.analysis,
        deliveries: result.deliveries,
        recipients: uniqueRecipients.length,
      });
    } catch (error) {
      console.error('❌ Error in QualityController.sendDailyAnalysis:', error.message);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to send daily analysis',
      });
    }
  };
}

module.exports = QualityController;

