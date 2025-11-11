class ErrorLogController {
  constructor(errorLogService) {
    this.errorLogService = errorLogService;
  }

  async getErrorLogs(req, res) {
    try {
      console.log('📝 Fetching error logs with filters:', req.query);
      
      const filters = {
        server_ip: req.query.server_ip,
        log_level: req.query.log_level,
        start_date: req.query.start_date,
        end_date: req.query.end_date
      };

      const logs = await this.errorLogService.getErrorLogs(filters);
      
      console.log(`✅ Found ${logs.length} error logs`);
      
      res.json({
        success: true,
        data: logs,
        count: logs.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Error fetching error logs:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch error logs',
        message: error.message
      });
    }
  }

  async getErrorStats(req, res) {
    try {
      console.log('📊 Fetching error statistics');
      
      const stats = await this.errorLogService.getErrorStats();
      
      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Error fetching error stats:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch error statistics',
        message: error.message
      });
    }
  }

  async collectLogs(req, res) {
    try {
      console.log('🔄 Manual error log collection requested');
      
      const results = await this.errorLogService.collectErrorLogs();
      
      const totalLogs = results.reduce((sum, result) => sum + (result.logsSaved || 0), 0);
      
      res.json({
        success: true,
        message: `Error log collection completed. ${totalLogs} new logs saved.`,
        results: results,
        totalLogs: totalLogs,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Error collecting logs:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to collect error logs',
        message: error.message
      });
    }
  }
}

module.exports = ErrorLogController;