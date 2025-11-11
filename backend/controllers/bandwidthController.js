class BandwidthController {
  constructor(bandwidthService) {
    this.bandwidthService = bandwidthService;
  }

  async getIPsBatch(req, res) {
    try {
      const { offset = 0, limit = 6, start, end, proxyPort } = req.query;

      if (!proxyPort) {
        return res.status(400).json({
          success: false,
          error: 'proxyPort is required'
        });
      }

      const result = await this.bandwidthService.getIPsBatch(
        parseInt(offset),
        parseInt(limit),
        start,
        end,
        proxyPort
      );

      res.json({
        success: true,
        ips: result.ips,
        ipDetails: result.ipDetails,
        pagination: result.pagination
      });

    } catch (error) {
      console.error('❌ Error in getIPsBatch:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch IP batch'
      });
    }
  }


  async getBandwidthData(req, res) {
    try {
      const { ip } = req.params;
      const { proxyPort, limit = 1400, start, end } = req.query;

      if (!ip) {
        return res.status(400).json({
          success: false,
          error: 'IP address is required'
        });
      }

      if (!proxyPort) {
        return res.status(400).json({
          success: false,
          error: 'proxyPort is required'
        });
      }

      const data = await this.bandwidthService.getBandwidthData(
        ip,
        proxyPort,
        limit.toString(),
        start,
        end
      );
      res.json({
        success: true,
        ip,
        proxyPort,
        data,
        dataPoints: data.length
      });

    } catch (error) {
      console.error('❌ Error in getBandwidthData:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch bandwidth data'
      });
    }
  }


  async getBandwidthDataByGroup(req, res) {
    try {
      const { group } = req.params;
      const { limit = 1400, start, end } = req.query;

      if (!group) {
        return res.status(400).json({
          success: false,
          error: 'Group key is required'
        });
      }

      const data = await this.bandwidthService.getBandwidthDataByGroup(
        group,
        limit.toString(),
        start,
        end
      );

      res.json({
        success: true,
        group,
        data,
        dataPoints: data.length
      });

    } catch (error) {
      console.error('❌ Error in getBandwidthDataByGroup:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch bandwidth data for group'
      });
    }
  }


  async getBandwidthStats(req, res) {
    try {
      const totalIPs = await this.bandwidthService.getTotalIPsCount();

      res.json({
        success: true,
        stats: {
          totalTrackedIPs: totalIPs,
          collectionInterval: '1 minute'
        }
      });

    } catch (error) {
      console.error('❌ Error in getBandwidthStats:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch bandwidth stats'
      });
    }
  }
}

module.exports = BandwidthController;