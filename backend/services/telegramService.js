const axios = require('axios');

class TelegramService {
  constructor(options = {}) {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.enabled = Boolean(this.botToken && this.chatId);
    this.baseUrl = this.enabled
      ? `https://api.telegram.org/bot${this.botToken}/sendMessage`
      : null;
    this.lastSendTs = 0;
    this.minSendIntervalMs = 5000; // prevent accidental spam bursts
    this.chatLogService = options.chatLogService || null;
    this.botAccountId = options.botAccountId || null;
  }

  isEnabled() {
    return this.enabled;
  }

  async sendMessage(text, options = {}) {
    return this.sendToChat(this.chatId, text, options);
  }

  async sendToChat(chatId, text, options = {}) {
    if (!this.enabled || !chatId) {
      return { ok: false, error: 'disabled_or_missing_chat_id' };
    }

    const now = Date.now();
    if (now - this.lastSendTs < this.minSendIntervalMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.minSendIntervalMs - (now - this.lastSendTs))
      );
    }

    try {
      const payload = {
        chat_id: chatId,
        text,
        parse_mode: options.parseMode || 'MarkdownV2',
        disable_web_page_preview: true,
      };

      const response = await axios.post(this.baseUrl, payload, { timeout: 5000 });

      if (!response.data || !response.data.ok) {
        const description = response.data && response.data.description ? response.data.description : 'unknown_error';
        console.error('❌ Telegram send failed:', response.data);
        return { ok: false, error: description };
      }

      this.lastSendTs = Date.now();

      if (this.chatLogService && this.botAccountId) {
        try {
          await this.chatLogService.recordMessage({
            accountId: this.botAccountId,
            contactId: options.contactId || null,
            chatId,
            chatTitle: options.chatTitle || null,
            senderUsername: null,
            senderDisplay: 'Bot',
            direction: 'outgoing',
            message: text,
            hasMedia: Boolean(options.hasMedia),
            payload: { chatId, options },
            occurredAt: new Date(),
          });
        } catch (error) {
          console.error('⚠️ Failed to record outgoing chat message:', error.message);
        }
      }

      return { ok: true, result: response.data.result || null };
    } catch (error) {
      const description =
        (error.response && error.response.data && error.response.data.description) ||
        error.message ||
        'request_failed';
      console.error('❌ Telegram send error:', description);
      return { ok: false, error: description };
    }
  }

  /**
   * Escape MarkdownV2 reserved characters.
   * https://core.telegram.org/bots/api#markdownv2-style
   */
  static escape(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
  }
}

module.exports = TelegramService;

