const DatabaseService = require('../services/databaseService');

class MeasurementController {
  constructor(databaseService) {
    this.databaseService = databaseService;
  }

  async getLatestMeasurements(req, res) {
    try {
      const { proxyPort = '10220', limit = '100' } = req.query;
      const proxyPortNum = parseInt(proxyPort, 10);
      const limitNum = Math.min(parseInt(limit, 10), 500);
      
      if (isNaN(proxyPortNum) || isNaN(limitNum)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid parameters' 
        });
      }

      console.log(`📊 Fetching latest measurements for proxy port ${proxyPortNum}, limit ${limitNum}`);
      
      const measurements = await this.databaseService.getLatestMeasurements(proxyPortNum, limitNum);
      
      const uniqueResults = measurements
        .map(measurement => measurement.toFrontendFormat())
        .sort((a, b) => a.target.localeCompare(b.target));
      
      res.json({
        success: true,
        count: uniqueResults.length,
        proxyPort: proxyPortNum,
        results: uniqueResults
      });
      
    } catch (error) {
      console.error('❌ Error in getLatestMeasurements:', error.message);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch measurements',
        details: error.message
      });
    }
  }

  async getTimeline(req, res) {
    try {
      const { 
        proxyPort = '10220', 
        limitPerTarget = '30',
        page,
        pageSize = '20',
        optimized = 'true',
        safe = 'false' // Add safe mode parameter
      } = req.query;
      
      const proxyPortNum = parseInt(proxyPort, 10);
      const limitNum = Math.min(parseInt(limitPerTarget, 10), 100);
      
      if (isNaN(proxyPortNum) || isNaN(limitNum)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid parameters' 
        });
      }

      let result;
      
      try {
        if (safe === 'true') {
          // Use safe method with template literals
          result = await this.databaseService.getMeasurementsTimelineSafe(proxyPortNum, limitNum);
        } else if (page) {
          // Use paginated endpoint
          const pageNum = parseInt(page, 10);
          const pageSizeNum = Math.min(parseInt(pageSize, 10), 50);
          result = await this.databaseService.getMeasurementsTimelinePaginated(
            proxyPortNum, pageNum, pageSizeNum, limitNum
          );
        } else if (optimized === 'true') {
          // Use optimized single query
          result = await this.databaseService.getMeasurementsTimelineOptimized(proxyPortNum, limitNum);
        } else {
          // Use original method
          result = await this.databaseService.getMeasurementsTimeline(proxyPortNum, limitNum);
        }
        
        res.json({
          success: true,
          count: result.length,
          proxyPort: proxyPortNum,
          data: result
        });
        
      } catch (dbError) {
        // If parameterized queries fail, fall back to safe method
        console.log('🔄 Parameterized query failed, falling back to safe method');
        result = await this.databaseService.getMeasurementsTimelineSafe(proxyPortNum, limitNum);
        
        res.json({
          success: true,
          count: result.length,
          proxyPort: proxyPortNum,
          data: result,
          note: 'Used safe query method'
        });
      }
      
    } catch (error) {
      console.error('❌ Error in getTimeline:', error.message);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch timeline',
        details: error.message
      });
    }
  }

  async getTimelineHealth(req, res) {
    try {
      const { proxyPort = '10220' } = req.query;
      const proxyPortNum = parseInt(proxyPort, 10);
      
      const healthData = await this.databaseService.getTimelineHealth(proxyPortNum);
      
      res.json({
        success: true,
        targetCount: healthData.targetCount,
        latestMeasurement: healthData.latestMeasurement,
        proxyPort: proxyPortNum
      });
      
    } catch (error) {
      console.error('❌ Error in timeline health check:', error.message);
      res.status(500).json({ 
        success: false, 
        error: 'Health check failed'
      });
    }
  }
}

module.exports = MeasurementController;