class ContactController {
  constructor(contactService, accountService = null) {
    this.contactService = contactService;
    this.accountService = accountService;
  }

  list = async (req, res) => {
    try {
      const { important, role, accountId, accountKey } = req.query || {};
      const importantOnly = typeof important === 'string'
        && ['1', 'true', 'yes', 'on'].includes(important.toLowerCase());
      const roleFilter = typeof role === 'string' && role.trim().length > 0 ? role : null;
      let accountFilter = accountId ? Number(accountId) : null;

      if (!accountFilter && accountKey && this.accountService) {
        const account = await this.accountService.getAccountByKey(accountKey);
        accountFilter = account ? account.id : null;
      }

      const contacts = await this.contactService.listContacts({
        importantOnly,
        role: roleFilter,
        accountId: accountFilter,
      });
      res.json({ success: true, contacts });
    } catch (error) {
      console.error('❌ Failed to list contacts:', error.message);
      res.status(500).json({ success: false, error: 'Failed to fetch contacts' });
    }
  };

  create = async (req, res) => {
    try {
      const { name } = req.body || {};
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Name is required' });
      }
      const result = await this.contactService.createContact(req.body);
      res.status(201).json({ success: true, contact: { id: result.id } });
    } catch (error) {
      console.error('❌ Failed to create contact:', error.message);
      res.status(500).json({ success: false, error: 'Failed to create contact' });
    }
  };

  update = async (req, res) => {
    try {
      const { id } = req.params;
      const updated = await this.contactService.updateContact(id, req.body || {});
      if (!updated) {
        return res.status(404).json({ success: false, error: 'Contact not found' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Failed to update contact:', error.message);
      res.status(500).json({ success: false, error: 'Failed to update contact' });
    }
  };

  delete = async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await this.contactService.deleteContact(id);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Contact not found' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Failed to delete contact:', error.message);
      res.status(500).json({ success: false, error: 'Failed to delete contact' });
    }
  };

  sync = async (req, res) => {
    try {
      const expectedToken = process.env.EXTERNAL_ALERT_TOKEN;
      if (!expectedToken) {
        return res.status(503).json({
          success: false,
          error: 'Contact sync disabled (EXTERNAL_ALERT_TOKEN missing)',
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

      const { contacts, accountId, accountKey } = req.body || {};
      let resolvedAccountId = accountId || null;
      if (!resolvedAccountId && accountKey && this.accountService) {
        const account = await this.accountService.getAccountByKey(accountKey);
        resolvedAccountId = account ? account.id : null;
      }
      const result = await this.contactService.syncContacts(contacts || [], resolvedAccountId || null);
      res.json({ success: true, ...result });
    } catch (error) {
      console.error('❌ Failed to sync contacts:', error.message);
      res.status(500).json({ success: false, error: 'Failed to sync contacts' });
    }
  };
}

module.exports = ContactController;

