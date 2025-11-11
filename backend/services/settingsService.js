class SettingsService {
  constructor(db) {
    this.db = db;
  }

  async getSetting(key) {
    const [rows] = await this.db.execute(
      'SELECT setting_value FROM system_settings WHERE setting_key = ? LIMIT 1',
      [key]
    );
    if (!rows || rows.length === 0) {
      return null;
    }
    return rows[0].setting_value;
  }

  async setSetting(key, value) {
    await this.db.execute(
      `
        INSERT INTO system_settings (setting_key, setting_value)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE
          setting_value = VALUES(setting_value),
          updated_at = CURRENT_TIMESTAMP
      `,
      [key, value]
    );
  }

  async getBoolean(key, defaultValue = false) {
    const storedValue = await this.getSetting(key);
    if (storedValue === null || storedValue === undefined) {
      return defaultValue;
    }
    const normalized = String(storedValue).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  }
}

module.exports = SettingsService;

