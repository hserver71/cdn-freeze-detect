const express = require('express');
const router = express.Router();

module.exports = (bandwidthController) => {
  // Get grouped bandwidth view (grouped by region)
  router.get('/ips', (req, res) => bandwidthController.getIPsBatch(req, res));

  // Get bandwidth data for specific IP
  router.get('/data/:ip', (req, res) => bandwidthController.getBandwidthData(req, res));

  // Get aggregated bandwidth data for a region group
  router.get('/region/:group', (req, res) => bandwidthController.getBandwidthDataByGroup(req, res));

  // Get bandwidth stats
  router.get('/stats', (req, res) => bandwidthController.getBandwidthStats(req, res));

  return router;
};