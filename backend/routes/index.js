const express = require('express');
const router = express.Router();

const measurementRoutes = require('./measurements');
const systemRoutes = require('./system');
const historyRoutes = require('./history'); // Add this

module.exports = (measurementController, systemController, historyController) => {
  router.use('/measurements', measurementRoutes(measurementController));
  router.use('/system', systemRoutes(systemController));
  router.use('/history', historyRoutes(historyController)); // Add this
  
  return router;
};