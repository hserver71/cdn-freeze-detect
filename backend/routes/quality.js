const express = require('express');

module.exports = (qualityController) => {
  const router = express.Router();

  router.get('/current', qualityController.getCurrent);
  router.get('/ttl/history', qualityController.getTtlHistory);
  router.get('/bandwidth/history', qualityController.getBandwidthHistory);
  router.post('/telegram/summary', qualityController.sendTelegramSummary);
  router.post('/daily-analysis/send', qualityController.sendDailyAnalysis);
  router.get('/daily-analysis', qualityController.getDailyAnalysis);
  router.get('/analysis/daily', qualityController.getDailyAnalysis); // backward compatibility
  router.post('/external-alert', qualityController.receiveExternalAlert);

  return router;
};

