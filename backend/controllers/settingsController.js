class SettingsController {
  constructor(settingsService) {
    this.settingsService = settingsService;
  }

  getNotifyForwarding = async (req, res) => {
    try {
      const enabled = await this.settingsService.getBoolean('notify_forwarding_enabled', false);
      res.json({ success: true, enabled });
    } catch (error) {
      console.error('❌ Failed to load notify forwarding setting:', error.message);
      res.status(500).json({ success: false, error: 'Failed to load setting' });
    }
  };

  updateNotifyForwarding = async (req, res) => {
    try {
      const { enabled } = req.body || {};
      const normalized =
        enabled === true ||
        enabled === 'true' ||
        enabled === 1 ||
        enabled === '1' ||
        enabled === 'on';
      await this.settingsService.setSetting('notify_forwarding_enabled', normalized ? '1' : '0');
      res.json({ success: true, enabled: normalized });
    } catch (error) {
      console.error('❌ Failed to update notify forwarding setting:', error.message);
      res.status(500).json({ success: false, error: 'Failed to update setting' });
    }
  };
}

module.exports = SettingsController;

