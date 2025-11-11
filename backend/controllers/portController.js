class PortController {
  constructor(portService, onChange = null) {
    this.portService = portService;
    this.onChange = typeof onChange === 'function' ? onChange : null;
  }

  listPorts = async (req, res) => {
    try {
      const ports = await this.portService.listPorts();
      res.json({
        success: true,
        ports,
      });
    } catch (error) {
      console.error('❌ Error listing ports:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to list ports',
      });
    }
  };

  upsertPort = async (req, res) => {
    try {
      const {
        portNumber,
        country,
        countryShort,
        provider,
        providerShort,
      } = req.body || {};

      if (!portNumber || !country || !countryShort || !provider || !providerShort) {
        return res.status(400).json({
          success: false,
          error: 'Missing required port fields',
        });
      }

      const portData = {
        portNumber: Number(portNumber),
        country: country.trim(),
        countryShort: countryShort.trim(),
        provider: provider.trim(),
        providerShort: providerShort.trim(),
      };

      const port = await this.portService.upsertPort(portData);
      if (this.onChange) {
        await this.onChange();
      }

      res.json({
        success: true,
        port,
      });
    } catch (error) {
      console.error('❌ Error saving port:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to save port',
      });
    }
  };

  deletePort = async (req, res) => {
    try {
      const { portNumber } = req.params;
      if (!portNumber) {
        return res.status(400).json({
          success: false,
          error: 'portNumber is required',
        });
      }

      const deleted = await this.portService.deletePort(Number(portNumber));
      if (deleted && this.onChange) {
        await this.onChange();
      }

      res.json({
        success: true,
        deleted,
      });
    } catch (error) {
      console.error('❌ Error deleting port:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to delete port',
      });
    }
  };
}

module.exports = PortController;


