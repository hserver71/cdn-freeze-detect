const express = require('express');
const router = express.Router();

const measurementRoutes = require('./measurements');
const systemRoutes = require('./system');
const historyRoutes = require('./history');
const bandwidthRoutes = require('./bandwidth');
const errorLogRoutes = require('./errorLog');
const portRoutes = require('./ports');
const metricsRoutes = require('./metrics');
const qualityRoutes = require('./quality');
const contactRoutes = require('./contacts');

module.exports = (measurementController, systemController, historyController, bandwidthController, errorLogController, metricsController, qualityController, contactController, portController) => {
  router.use('/measurements', measurementRoutes(measurementController));
  router.use('/system', systemRoutes(systemController));
  router.use('/history', historyRoutes(historyController));
  router.use('/bandwidth', bandwidthRoutes(bandwidthController));
  router.use('/errors', errorLogRoutes(errorLogController));
  router.use('/metrics', metricsRoutes(metricsController));
  router.use('/quality', qualityRoutes(qualityController));
  router.use('/contacts', contactRoutes(contactController));
  router.use('/ports', portRoutes(portController));
  return router;
};