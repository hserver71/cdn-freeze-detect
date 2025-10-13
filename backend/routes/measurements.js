const express = require('express');
const router = express.Router();

module.exports = (measurementController) => {
  // Get latest measurements
  router.get('/latest', (req, res) => measurementController.getLatestMeasurements(req, res));
  
  // Get timeline data
  router.get('/timeline', (req, res) => measurementController.getTimeline(req, res));
  
  return router;
};