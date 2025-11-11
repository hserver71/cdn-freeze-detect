const express = require('express');
const router = express.Router();

module.exports = (errorLogController) => {
  router.get('/', errorLogController.getErrorLogs.bind(errorLogController));
  router.get('/stats', errorLogController.getErrorStats.bind(errorLogController));
  router.post('/collect', errorLogController.collectLogs.bind(errorLogController));
  return router;
};