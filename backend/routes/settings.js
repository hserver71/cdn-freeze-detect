const express = require('express');

module.exports = (settingsController) => {
  const router = express.Router();

  router.get('/notify-forwarding', settingsController.getNotifyForwarding);
  router.post('/notify-forwarding', settingsController.updateNotifyForwarding);

  return router;
};

