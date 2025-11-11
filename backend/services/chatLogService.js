const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

class ChatLogService {
  constructor(db) {
    this.db = db;
  }

  async recordMessage({
    accountId,
    contactId = null,
    chatId = null,
    chatTitle = null,
    senderUsername = null,
    senderDisplay = null,
    direction = 'incoming',
    message = '',
    hasMedia = false,
    payload = null,
    occurredAt = null,
  }) {
    if (!accountId) {
      throw new Error('accountId is required to record chat message');
    }

    const occurredValue = occurredAt ? new Date(occurredAt) : new Date();

    await this.db.execute(
      `INSERT INTO chat_messages
        (account_id, contact_id, chat_id, chat_title, sender_username, sender_display,
         direction, message, has_media, payload, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        accountId,
        contactId || null,
        chatId || null,
        chatTitle || null,
        senderUsername || null,
        senderDisplay || null,
        direction,
        message || '',
        hasMedia ? 1 : 0,
        payload ? JSON.stringify(payload) : null,
        occurredValue.toISOString().slice(0, 19).replace('T', ' '),
      ]
    );
  }

  /**
   * Fetch chat messages with pagination and optional search.
   */
  async getMessages({
    accountId,
    contactId = null,
    chatId = null,
    direction = null,
    search = null,
    beforeId = null,
    beforeDate = null,
    limit = DEFAULT_PAGE_SIZE,
  }) {
    if (!accountId) {
      throw new Error('accountId is required');
    }

    const effectiveLimit = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const where = ['account_id = ?'];
    const params = [accountId];

    if (contactId) {
      where.push('contact_id = ?');
      params.push(contactId);
    }
    if (chatId) {
      where.push('chat_id = ?');
      params.push(chatId);
    }
    if (direction) {
      where.push('direction = ?');
      params.push(direction);
    }
    if (beforeId) {
      where.push('id < ?');
      params.push(beforeId);
    }
    if (beforeDate) {
      where.push('occurred_at < ?');
      params.push(new Date(beforeDate));
    }
    if (search) {
      where.push('MATCH(message) AGAINST (? IN NATURAL LANGUAGE MODE)');
      params.push(search);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const limitParam = String(effectiveLimit);

    try {
      const [rows] = await this.db.execute(
      `
        SELECT
          id,
          account_id AS accountId,
          contact_id AS contactId,
          chat_id AS chatId,
          chat_title AS chatTitle,
          sender_username AS senderUsername,
          sender_display AS senderDisplay,
          direction,
          message,
          has_media AS hasMedia,
          payload,
          occurred_at AS occurredAt,
          created_at AS createdAt
        FROM chat_messages
        ${whereSql}
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?
      `,
      [...params, limitParam]
    );

      return rows.map((row) => {
        let parsedPayload = null;
        if (row.payload !== null && row.payload !== undefined) {
          if (typeof row.payload === 'string') {
            try {
              parsedPayload = JSON.parse(row.payload);
            } catch (parseError) {
              // Fallback to raw string when JSON parsing fails
              parsedPayload = row.payload;
            }
          } else {
            parsedPayload = row.payload;
          }
        }

        return {
          ...row,
          occurredAt: row.occurredAt ? new Date(row.occurredAt).toISOString() : null,
          createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
          hasMedia: Boolean(row.hasMedia),
          payload: parsedPayload,
        };
      });
    } catch (error) {
      console.error('❌ ChatLogService.getMessages failed', {
        whereSql,
        params,
        effectiveLimit,
        limitParam,
        error: error.message,
      });
      throw error;
    }
  }

  async getMessageById({ accountId, messageId, contactId = null }) {
    if (!accountId || !messageId) {
      throw new Error('accountId and messageId are required');
    }

    const params = [accountId, messageId];
    let contactClause = '';
    if (contactId) {
      contactClause = 'AND contact_id = ?';
      params.push(contactId);
    }

    const [rows] = await this.db.execute(
      `
        SELECT
          id,
          account_id AS accountId,
          contact_id AS contactId,
          chat_id AS chatId,
          chat_title AS chatTitle,
          sender_username AS senderUsername,
          sender_display AS senderDisplay,
          direction,
          message,
          has_media AS hasMedia,
          payload,
          occurred_at AS occurredAt,
          created_at AS createdAt
        FROM chat_messages
        WHERE account_id = ?
          AND id = ?
          ${contactClause}
        LIMIT 1
      `,
      params
    );

    if (!rows || rows.length === 0) {
      return null;
    }

    const row = rows[0];
    let parsedPayload = null;
    if (row.payload !== null && row.payload !== undefined) {
      if (typeof row.payload === 'string') {
        try {
          parsedPayload = JSON.parse(row.payload);
        } catch (parseError) {
          parsedPayload = row.payload;
        }
      } else {
        parsedPayload = row.payload;
      }
    }

    return {
      ...row,
      occurredAt: row.occurredAt ? new Date(row.occurredAt).toISOString() : null,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
      hasMedia: Boolean(row.hasMedia),
      payload: parsedPayload,
    };
  }
}

module.exports = ChatLogService;


