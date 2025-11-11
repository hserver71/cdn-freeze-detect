class AccountController {
  constructor(accountService, contactService, chatLogService, telegramService = null) {
    this.accountService = accountService;
    this.contactService = contactService;
    this.chatLogService = chatLogService;
    this.telegramService = telegramService;
  }

  list = async (req, res) => {
    try {
      const accounts = await this.accountService.listAccounts();
      res.json({ success: true, accounts });
    } catch (error) {
      console.error('❌ Failed to list accounts:', error.message);
      res.status(500).json({ success: false, error: 'Failed to fetch accounts' });
    }
  };

  create = async (req, res) => {
    try {
      const { name, type, accountKey, notes } = req.body || {};
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Name is required' });
      }
      const result = await this.accountService.createAccount({ name, type, accountKey, notes });
      res.status(201).json({ success: true, account: { id: result.id } });
    } catch (error) {
      console.error('❌ Failed to create account:', error.message);
      res.status(500).json({ success: false, error: 'Failed to create account' });
    }
  };

  update = async (req, res) => {
    try {
      const { id } = req.params;
      const updated = await this.accountService.updateAccount(id, req.body || {});
      if (!updated) {
        return res.status(404).json({ success: false, error: 'Account not found' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Failed to update account:', error.message);
      res.status(500).json({ success: false, error: 'Failed to update account' });
    }
  };

  remove = async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await this.accountService.deleteAccount(id);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Account not found' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Failed to delete account:', error.message);
      res.status(500).json({ success: false, error: 'Failed to delete account' });
    }
  };

  contacts = async (req, res) => {
    try {
      const { id } = req.params;
      const account = await this.accountService.getAccountById(id);
      if (!account) {
        return res.status(404).json({ success: false, error: 'Account not found' });
      }
      const contacts = await this.contactService.listContacts({ accountId: id });
      res.json({ success: true, contacts });
    } catch (error) {
      console.error('❌ Failed to load account contacts:', error.message);
      res.status(500).json({ success: false, error: 'Failed to fetch contacts' });
    }
  };

  messages = async (req, res) => {
    try {
      const { id, contactId } = req.params;
      const {
        chatId = null,
        direction = null,
        search = null,
        beforeId = null,
        beforeDate = null,
        limit = null,
      } = req.query;

      const account = await this.accountService.getAccountById(id);
      if (!account) {
        return res.status(404).json({ success: false, error: 'Account not found' });
      }

      const messages = await this.chatLogService.getMessages({
        accountId: Number(id),
        contactId: contactId ? Number(contactId) : null,
        chatId: chatId ? Number(chatId) : null,
        direction: direction || null,
        search: search || null,
        beforeId: beforeId ? Number(beforeId) : null,
        beforeDate: beforeDate || null,
        limit: limit ? Number(limit) : undefined,
      });

      res.json({ success: true, messages });
    } catch (error) {
      console.error('❌ Failed to load chat messages:', error.message);
      res.status(500).json({ success: false, error: 'Failed to fetch chat messages' });
    }
  };

  notifyMessage = async (req, res) => {
    try {
      const { id: accountIdParam, contactId: contactIdParam, messageId: messageIdParam } = req.params;
      const accountId = Number(accountIdParam);
      const contactId = Number(contactIdParam);
      const messageId = Number(messageIdParam);

      if (!accountId || !messageId) {
        return res.status(400).json({ success: false, error: 'Invalid account or message id' });
      }

      if (!this.telegramService || !this.telegramService.isEnabled()) {
        return res.status(503).json({ success: false, error: 'Telegram notifications disabled' });
      }

      const account = await this.accountService.getAccountById(accountId);
      if (!account) {
        return res.status(404).json({ success: false, error: 'Account not found' });
      }

      const message = await this.chatLogService.getMessageById({ accountId, messageId, contactId });
      if (!message) {
        return res.status(404).json({ success: false, error: 'Message not found' });
      }

      const primaryTargets = await this.contactService.listContacts({
        accountId,
        role: 'notify target',
      });
      const secondaryTargets = await this.contactService.listContacts({
        accountId,
        role: 'notify',
      });

      const targetMap = new Map();
      primaryTargets.forEach((contact) => targetMap.set(contact.id, contact));
      secondaryTargets.forEach((contact) => {
        if (!targetMap.has(contact.id)) {
          targetMap.set(contact.id, contact);
        }
      });

      if (targetMap.size === 0) {
        return res.status(400).json({
          success: false,
          error: 'No notify target contacts configured for this account',
        });
      }

      const payloadDetails = {
        forwardedMessageId: message.id,
        originalContactId: message.contactId,
        notifyTriggeredBy: contactId || null,
      };

      const escapeFn =
        this.telegramService.constructor && typeof this.telegramService.constructor.escape === 'function'
          ? this.telegramService.constructor.escape
          : (value) => value || '';

      const recipients = [];

      for (const contact of targetMap.values()) {
        const normalizedUsername = contact.telegramUsername
          ? contact.telegramUsername.startsWith('@')
            ? contact.telegramUsername
            : `@${contact.telegramUsername}`
          : null;
        const targetChat = contact.telegramChatId ? contact.telegramChatId : normalizedUsername;

        if (!targetChat) {
          recipients.push({ contactId: contact.id, sent: false, reason: 'missing_target' });
          continue;
        }

        const escapedText = escapeFn(message.message || '');
        const sentResult = await this.telegramService.sendToChat(targetChat, escapedText, {
          parseMode: 'MarkdownV2',
          contactId: contact.id,
          chatTitle: message.chatTitle || null,
        });

        const sentOk = Boolean(sentResult && sentResult.ok);

        if (sentOk && this.chatLogService) {
          try {
            await this.chatLogService.recordMessage({
              accountId,
              contactId: contact.id,
              chatId: contact.telegramChatId || null,
              chatTitle: contact.name || message.chatTitle || null,
              senderUsername: null,
              senderDisplay: 'Bot',
              direction: 'outgoing',
              message: message.message || '',
              hasMedia: Boolean(message.hasMedia),
              payload: payloadDetails,
              occurredAt: new Date(),
            });
          } catch (logError) {
            console.error('⚠️ Failed to log notify message:', logError.message);
          }
        }

        recipients.push({
          contactId: contact.id,
          chatId: targetChat,
          sent: sentOk,
          error: sentOk ? null : sentResult ? sentResult.error : 'send_failed',
        });
      }

      const notifyCount = recipients.filter((result) => result.sent).length;

      res.json({
        success: true,
        notifyCount,
        recipients,
      });
    } catch (error) {
      console.error('❌ Failed to notify contacts:', error.message);
      res.status(500).json({ success: false, error: 'Failed to send notifications' });
    }
  };
}

module.exports = AccountController;


