const normalizeRole = (role) => (role ? role.trim().toLowerCase() : null);
const NOTIFY_ROLES = new Set(['notify', 'notify target']);

class ContactService {
  constructor(db) {
    this.db = db;
  }

  async listContacts(options = {}) {
    const filters = options || {};
    const whereClauses = [];
    const params = [];

    if (filters.accountId) {
      whereClauses.push('account_id = ?');
      params.push(filters.accountId);
    }
    if (filters.importantOnly) {
      whereClauses.push('is_important = 1');
    }

    if (filters.role) {
      whereClauses.push('role IS NOT NULL AND LOWER(role) = ?');
      params.push(normalizeRole(filters.role));
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const query = `
      SELECT id, account_id AS accountId, name,
             telegram_username AS telegramUsername,
             telegram_chat_id AS telegramChatId,
             first_name AS firstName,
             last_name AS lastName,
             telegram_phone AS telegramPhone,
             role, is_important AS isImportant, notify_on_external AS notifyOnExternal,
             notes, created_at AS createdAt, updated_at AS updatedAt
      FROM contacts
      ${whereSql}
      ORDER BY is_important DESC, name ASC
    `;
    const [rows] = await this.db.execute(query, params);
    return rows;
  }

  async createContact(payload) {
    const {
      name,
      telegramUsername = null,
      telegramChatId = null,
      firstName = null,
      lastName = null,
      telegramPhone = null,
      role = null,
      isImportant = false,
      notifyOnExternal = true,
      notes = null,
      accountId = null,
    } = payload;

    const normalizedRole = role ? role.trim() : null;
    const derivedIsImportant = isImportant || Boolean(normalizedRole);
    const derivedNotifyOnExternal = notifyOnExternal || Boolean(normalizedRole);

    const query = `
      INSERT INTO contacts
        (account_id, name, telegram_username, telegram_chat_id, first_name, last_name, telegram_phone, role, is_important, notify_on_external, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [result] = await this.db.execute(query, [
      accountId || null,
      name.trim(),
      telegramUsername ? telegramUsername.trim() : null,
      telegramChatId || null,
      firstName ? firstName.trim() : null,
      lastName ? lastName.trim() : null,
      telegramPhone ? telegramPhone.trim() : null,
      normalizedRole,
      derivedIsImportant ? 1 : 0,
      derivedNotifyOnExternal ? 1 : 0,
      notes || null,
    ]);

    return { id: result.insertId };
  }

  async updateContact(id, payload) {
    const fields = [];
    const values = [];

    const setField = (column, value, transform = (v) => v) => {
      fields.push(`${column} = ?`);
      values.push(transform(value));
    };

    if (payload.name !== undefined) {
      setField('name', payload.name.trim());
    }
    if (payload.telegramUsername !== undefined) {
      setField('telegram_username', payload.telegramUsername ? payload.telegramUsername.trim() : null);
    }
    if (payload.telegramChatId !== undefined) {
      setField('telegram_chat_id', payload.telegramChatId || null);
    }
    if (payload.accountId !== undefined) {
      setField('account_id', payload.accountId || null);
    }
    if (payload.role !== undefined) {
      const normalizedRole = payload.role ? payload.role.trim() : null;
      setField('role', normalizedRole);

      if (payload.isImportant === undefined) {
        setField('is_important', normalizedRole ? 1 : 0);
      }
      if (payload.notifyOnExternal === undefined) {
        setField('notify_on_external', normalizedRole ? 1 : 0);
      }
    }
    if (payload.isImportant !== undefined) {
      setField('is_important', payload.isImportant ? 1 : 0);
    }
    if (payload.notifyOnExternal !== undefined) {
      setField('notify_on_external', payload.notifyOnExternal ? 1 : 0);
    }
    if (payload.notes !== undefined) {
      setField('notes', payload.notes || null);
    }
    if (payload.firstName !== undefined) {
      setField('first_name', payload.firstName ? payload.firstName.trim() : null);
    }
    if (payload.lastName !== undefined) {
      setField('last_name', payload.lastName ? payload.lastName.trim() : null);
    }
    if (payload.telegramPhone !== undefined) {
      setField('telegram_phone', payload.telegramPhone ? payload.telegramPhone.trim() : null);
    }

    if (fields.length === 0) {
      return false;
    }

    const query = `
      UPDATE contacts
      SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;

    values.push(id);
    const [result] = await this.db.execute(query, values);
    return result.affectedRows > 0;
  }

  async deleteContact(id) {
    const [result] = await this.db.execute('DELETE FROM contacts WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async getNotifiableContacts() {
    const notifyRoleList = Array.from(NOTIFY_ROLES);
    const placeholders = notifyRoleList.map(() => '?').join(', ');
    const query = `
      SELECT id, name, telegram_username AS telegramUsername, telegram_chat_id AS telegramChatId,
             is_important AS isImportant, role
      FROM contacts
      WHERE notify_on_external = 1
        AND role IS NOT NULL
        AND LOWER(role) IN (${placeholders})
    `;
    const [rows] = await this.db.execute(query, notifyRoleList);
    return rows;
  }

  async findContactByChat({ accountId = null, telegramChatId = null, telegramUsername = null }) {
    const matchParts = [];
    const params = [];

    if (telegramChatId) {
      matchParts.push('telegram_chat_id = ?');
      params.push(telegramChatId);
    }

    if (telegramUsername) {
      const normalized = telegramUsername.startsWith('@')
        ? telegramUsername.slice(1)
        : telegramUsername;
      matchParts.push('telegram_username = ?');
      params.push(normalized);
    }

    if (matchParts.length === 0) {
      return null;
    }

    let whereClause = `(${matchParts.join(' OR ')})`;

    if (accountId) {
      whereClause += ' AND (account_id IS NULL OR account_id = ?)';
      params.push(accountId);
    }

    const [rows] = await this.db.execute(
      `
        SELECT id, account_id AS accountId, name, telegram_username AS telegramUsername,
               telegram_chat_id AS telegramChatId
        FROM contacts
        WHERE ${whereClause}
        ORDER BY account_id IS NULL DESC, updated_at DESC
        LIMIT 1
      `,
      params
    );

    return rows[0] || null;
  }

  async findContactByAccountAndTelegram({ accountId, telegramChatId = null, telegramUsername = null }) {
    if (!accountId) {
      throw new Error('accountId is required');
    }

    const matchClauses = [];
    const params = [accountId];

    if (telegramChatId) {
      matchClauses.push('telegram_chat_id = ?');
      params.push(telegramChatId);
    }

    if (telegramUsername) {
      const normalized = telegramUsername.startsWith('@')
        ? telegramUsername.slice(1)
        : telegramUsername;
      matchClauses.push('telegram_username = ?');
      params.push(normalized);
    }

    if (matchClauses.length === 0) {
      return null;
    }

    const whereClause = `account_id = ? AND (${matchClauses.join(' OR ')})`;
    const [rows] = await this.db.execute(
      `
        SELECT id, account_id AS accountId, name, telegram_username AS telegramUsername,
               telegram_chat_id AS telegramChatId, role
        FROM contacts
        WHERE ${whereClause}
        LIMIT 1
      `,
      params
    );

    return rows[0] || null;
  }

  async syncContacts(contactList = [], accountId = null) {
    if (!Array.isArray(contactList) || contactList.length === 0) {
      return { inserted: 0, updated: 0 };
    }

    let inserted = 0;
    let updated = 0;

    for (const entry of contactList) {
      const telegramChatId = entry.telegramChatId || null;
      const telegramUsername = entry.telegramUsername ? entry.telegramUsername.trim() : null;
      const name = (entry.name || '').trim()
        || [entry.firstName, entry.lastName].filter(Boolean).join(' ').trim()
        || telegramUsername
        || (telegramChatId ? String(telegramChatId) : 'Unknown');

      const firstName = entry.firstName ? entry.firstName.trim() : null;
      const lastName = entry.lastName ? entry.lastName.trim() : null;
      const phone = entry.telegramPhone ? entry.telegramPhone.trim() : null;

      let existing = [];
      const normalizedUsername = telegramUsername
        ? (telegramUsername.startsWith('@') ? telegramUsername.slice(1) : telegramUsername)
        : null;

      const searchClauses = [];
      const searchParams = [];

      if (telegramChatId) {
        searchClauses.push('telegram_chat_id = ?');
        searchParams.push(telegramChatId);
      }
      if (normalizedUsername) {
        searchClauses.push('telegram_username = ?');
        searchParams.push(normalizedUsername);
      }

      if (searchClauses.length > 0) {
        if (accountId) {
          const accountQuery = `
            SELECT id FROM contacts
            WHERE account_id = ?
              AND (${searchClauses.join(' OR ')})
            LIMIT 1
          `;
          const [rows] = await this.db.execute(accountQuery, [accountId, ...searchParams]);
          if (rows.length > 0) {
            existing = rows;
          }
        }

        if (existing.length === 0) {
          const nullAccountQuery = `
            SELECT id FROM contacts
            WHERE account_id IS NULL
              AND (${searchClauses.join(' OR ')})
            LIMIT 1
          `;
          const [rows] = await this.db.execute(nullAccountQuery, searchParams);
          if (rows.length > 0) {
            existing = rows;
          }
        }
      }

      if (existing.length > 0) {
        const id = existing[0].id;
        await this.db.execute(
          `
            UPDATE contacts
            SET name = COALESCE(?, name),
                telegram_username = COALESCE(?, telegram_username),
                telegram_chat_id = COALESCE(?, telegram_chat_id),
                first_name = COALESCE(?, first_name),
                last_name = COALESCE(?, last_name),
                telegram_phone = COALESCE(?, telegram_phone),
                account_id = COALESCE(?, account_id),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `,
          [
            name || null,
            normalizedUsername || telegramUsername || null,
            telegramChatId || null,
            firstName,
            lastName,
            phone,
            accountId,
            id,
          ]
        );
        updated += 1;
      } else {
        await this.createContact({
          name,
          telegramUsername,
          telegramChatId,
          firstName,
          lastName,
          telegramPhone: phone,
          notifyOnExternal: true,
          accountId,
        });
        inserted += 1;
      }
    }

    return { inserted, updated };
  }
}

module.exports = ContactService;

