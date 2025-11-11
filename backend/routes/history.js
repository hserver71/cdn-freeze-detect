const express = require('express');
const router = express.Router();

module.exports = (historyController) => {
  // Get chart data for history panel
  router.get('/chart-data', (req, res) => historyController.getChartData(req, res));
  return router;
};