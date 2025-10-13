const express = require('express');
const router = express.Router();

module.exports = (historyController) => {
  // Get chart data for history panel
  router.get('/chart-data', (req, res) => historyController.getChartData(req, res));
  router.get('/search-ip', (req, res) => historyController.searchIP(req, res));
  return router;
};