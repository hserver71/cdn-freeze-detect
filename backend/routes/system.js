const express = require('express');
const router = express.Router();

module.exports = (systemController) => {
  // Health check
  router.get('/health', (req, res) => systemController.healthCheck(req, res));
  
  // Database info
  router.get('/db-info', (req, res) => systemController.getDatabaseInfo(req, res));
  
  // Test database
  router.get('/test-db', (req, res) => systemController.testDatabase(req, res));
  
  return router;
};