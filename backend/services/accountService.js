class AccountService {
  constructor(db) {
    this.db = db;
  }

  async listAccounts() {
    const [rows] = await this.db.execute(
      `SELECT id, name, account_key AS accountKey, type, notes, created_at AS createdAt, updated_at AS updatedAt
       FROM accounts
       ORDER BY name ASC`
    );
    return rows;
  }

  async getAccountById(id) {
    const [rows] = await this.db.execute(
      `SELECT id, name, account_key AS accountKey, type, notes
       FROM accounts
       WHERE id = ?
       LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  }

  async getAccountByKey(accountKey) {
    if (!accountKey) return null;
    const [rows] = await this.db.execute(
      `SELECT id, name, account_key AS accountKey, type, notes
       FROM accounts
       WHERE account_key = ?
       LIMIT 1`,
      [accountKey]
    );
    return rows[0] || null;
  }

  async ensureAccount({ name, type = 'personal', accountKey = null }) {
    if (accountKey) {
      const existing = await this.getAccountByKey(accountKey);
      if (existing) {
        return existing;
      }
    }

    const [result] = await this.db.execute(
      `INSERT INTO accounts (name, type, account_key)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), type = VALUES(type)`,
      [name, type, accountKey]
    );

    const id = result.insertId > 0 ? result.insertId : (await this.getAccountByKey(accountKey))?.id;
    return this.getAccountById(id);
  }

  async createAccount({ name, type = 'personal', accountKey = null, notes = null }) {
    const [result] = await this.db.execute(
      `INSERT INTO accounts (name, type, account_key, notes)
       VALUES (?, ?, ?, ?)`,
      [name.trim(), type, accountKey || null, notes || null]
    );
    return { id: result.insertId };
  }

  async updateAccount(id, payload = {}) {
    const fields = [];
    const values = [];

    const setField = (column, value) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };

    if (payload.name !== undefined) setField('name', payload.name.trim());
    if (payload.type !== undefined) setField('type', payload.type);
    if (payload.accountKey !== undefined) setField('account_key', payload.accountKey || null);
    if (payload.notes !== undefined) setField('notes', payload.notes || null);

    if (fields.length === 0) {
      return false;
    }

    const [result] = await this.db.execute(
      `UPDATE accounts
       SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [...values, id]
    );

    return result.affectedRows > 0;
  }

  async deleteAccount(id) {
    const [result] = await this.db.execute('DELETE FROM accounts WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }
}

module.exports = AccountService;


