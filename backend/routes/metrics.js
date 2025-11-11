const express = require('express');
const router = express.Router();

module.exports = (metricsController) => {
  // Save metrics (POST)
  router.post('/', (req, res) => metricsController.saveMetrics(req, res));
  
  // Get list of servers (GET) - Must be before /:server route
  router.get('/servers/list', (req, res) => metricsController.getServersList(req, res));
  
  // Get summary statistics (GET) - Must be before /:server route
  router.get('/stats/summary', (req, res) => metricsController.getMetricsSummary(req, res));
  
  // Get all metrics with optional filters (GET)
  router.get('/', (req, res) => metricsController.getMetrics(req, res));
  
  // Get metrics for a specific server (GET) - Must be last
  router.get('/:server', (req, res) => metricsController.getServerMetrics(req, res));
  
  return router;
};

