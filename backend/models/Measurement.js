class Measurement {
  constructor(data) {
    this.target_host = data.target_host;
    this.target_port = data.target_port;
    this.proxy_host = data.proxy_host;
    this.proxy_port = data.proxy_port;
    this.status = data.status;
    this.rtt_ms = data.rtt_ms;
    this.error_message = data.error_message;
    this.message = data.message;
    this.created_at = data.created_at;
    this.measurement_type = data.measurement_type || 'http'; // Track measurement type
  }

  toFrontendFormat() {
    return {
      target: `${this.target_host}:${this.target_port}`,
      proxy: `${this.proxy_host}:${this.proxy_port}`,
      status: this.status,
      rtt: this.rtt_ms ? `${this.rtt_ms}ms` : null,
      error: this.error_message,
      message: this.message,
      timestamp: this.created_at,
      measurement_type: this.measurement_type
    };
  }

  static fromNetworkResult(result) {
    const targetParts = result.target.split(':');
    const proxyParts = result.proxy.split(':');
    
    return new Measurement({
      target_host: targetParts[0],
      target_port: parseInt(targetParts[1]) || 80,
      proxy_host: proxyParts[0],
      proxy_port: parseInt(proxyParts[1]) || 10220,
      status: result.status,
      rtt_ms: result.rtt ? parseFloat(result.rtt.replace('ms', '')) : null,
      error_message: result.error,
      message: result.message,
      measurement_type: result.measurement_type || 'http'
    });
  }
}

module.exports = Measurement;