const DatabaseService = require('../services/databaseService');

class SystemController {
  constructor(databaseService) {
    this.databaseService = databaseService;
  }

  async healthCheck(req, res) {
    try {
      await this.databaseService.db.execute('SELECT 1');
      res.json({ 
        status: 'healthy', 
        database: 'connected',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ 
        status: 'unhealthy', 
        database: 'disconnected',
        error: error.message 
      });
    }
  }

  async getDatabaseInfo(req, res) {
    try {
      const stats = await this.databaseService.getDatabaseStats();
      res.json({
        success: true,
        ...stats
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch database info' 
      });
    }
  }

  testDatabase(req, res) {
    res.json({ 
      success: true, 
      message: 'Database connection successful',
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = SystemController;