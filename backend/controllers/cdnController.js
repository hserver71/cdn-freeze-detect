class CdnController {
  constructor(cdnService) {
    this.cdnService = cdnService;
  }

  async getServers(req, res) {
    try {
      const servers = await this.cdnService.getServers();
      res.json({ success: true, servers });
    } catch (error) {
      console.error('❌ Error fetching CDN servers:', error.message);
      res.status(500).json({ success: false, error: 'Failed to fetch servers' });
    }
  }

  async createServer(req, res) {
    try {
      const { name, ipAddress } = req.body;
      if (!name || !ipAddress) {
        return res.status(400).json({ success: false, error: 'Name and IP address are required' });
      }

      const server = await this.cdnService.createServer({ name, ipAddress });
      res.status(201).json({ success: true, server });
    } catch (error) {
      console.error('❌ Error creating CDN server:', error.message);
      if (error.errno === 1062) {
        return res.status(409).json({ success: false, error: 'Server with same name or IP already exists' });
      }
      res.status(500).json({ success: false, error: 'Failed to create server' });
    }
  }

  async updateServer(req, res) {
    try {
      const { id } = req.params;
      const { name, ipAddress } = req.body;
      if (!name || !ipAddress) {
        return res.status(400).json({ success: false, error: 'Name and IP address are required' });
      }

      const updated = await this.cdnService.updateServer(id, { name, ipAddress });
      if (!updated) {
        return res.status(404).json({ success: false, error: 'Server not found' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Error updating CDN server:', error.message);
      if (error.errno === 1062) {
        return res.status(409).json({ success: false, error: 'Server with same name or IP already exists' });
      }
      res.status(500).json({ success: false, error: 'Failed to update server' });
    }
  }

  async deleteServer(req, res) {
    try {
      const { id } = req.params;
      const deleted = await this.cdnService.deleteServer(id);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Server not found' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Error deleting CDN server:', error.message);
      res.status(500).json({ success: false, error: 'Failed to delete server' });
    }
  }

  async getDomains(req, res) {
    try {
      const { serverId } = req.params;
      const domains = await this.cdnService.getDomains(serverId);
      res.json({ success: true, domains });
    } catch (error) {
      console.error('❌ Error fetching CDN domains:', error.message);
      res.status(500).json({ success: false, error: 'Failed to fetch domains' });
    }
  }

  async getDomainsByQuery(req, res) {
    try {
      const { ipAddress } = req.query;
      if (!ipAddress) {
        return res.status(400).json({ success: false, error: 'ipAddress query parameter is required' });
      }

      const result = await this.cdnService.getDomainsByIp(ipAddress);
      res.json({ success: true, ...result });
    } catch (error) {
      console.error('❌ Error fetching CDN domains by IP:', error.message);
      res.status(500).json({ success: false, error: 'Failed to fetch domains' });
    }
  }

  async createDomain(req, res) {
    try {
      const { serverId } = req.params;
      const { domain } = req.body;
      if (!domain) {
        return res.status(400).json({ success: false, error: 'Domain is required' });
      }

      const created = await this.cdnService.createDomain(serverId, domain);
      res.status(201).json({ success: true, domain: created });
    } catch (error) {
      console.error('❌ Error creating CDN domain:', error.message);
      if (error.errno === 1062) {
        return res.status(409).json({ success: false, error: 'Domain already exists for this server' });
      }
      res.status(500).json({ success: false, error: 'Failed to create domain' });
    }
  }

  async updateDomain(req, res) {
    try {
      const { id } = req.params;
      const { domain } = req.body;
      if (!domain) {
        return res.status(400).json({ success: false, error: 'Domain is required' });
      }

      const updated = await this.cdnService.updateDomain(id, domain);
      if (!updated) {
        return res.status(404).json({ success: false, error: 'Domain not found' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Error updating CDN domain:', error.message);
      if (error.errno === 1062) {
        return res.status(409).json({ success: false, error: 'Domain already exists for this server' });
      }
      res.status(500).json({ success: false, error: 'Failed to update domain' });
    }
  }

  async deleteDomain(req, res) {
    try {
      const { id } = req.params;
      const deleted = await this.cdnService.deleteDomain(id);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Domain not found' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Error deleting CDN domain:', error.message);
      res.status(500).json({ success: false, error: 'Failed to delete domain' });
    }
  }
}

module.exports = CdnController;

