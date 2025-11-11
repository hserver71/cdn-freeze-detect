import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './PortsPanel.css';

const INITIAL_FORM = {
  portNumber: '',
  country: '',
  countryShort: '',
  provider: '',
  providerShort: '',
};

const PortsPanel = () => {
  const [ports, setPorts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(INITIAL_FORM);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editingPort, setEditingPort] = useState(null);

  const fetchPorts = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const response = await fetch('/api/ports');
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to load ports');
      }
      const list = Array.isArray(data.ports) ? data.ports : [];
      list.sort((a, b) => Number(a.portNumber) - Number(b.portNumber));
      setPorts(list);
    } catch (err) {
      console.error('❌ Failed to fetch ports:', err);
      setError(err.message || 'Failed to load ports');
      setPorts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPorts();
  }, [fetchPorts]);

  const formatPortLabel = useCallback((port) => {
    if (!port) return '';
    const country = port.countryShort || port.country;
    const provider = port.providerShort || port.provider;
    const short = [country, provider].filter(Boolean).join('·');
    return short ? `${short} (${port.portNumber})` : `Port ${port.portNumber}`;
  }, []);

  const sortedPorts = useMemo(
    () =>
      ports.map((port) => ({
        ...port,
        label: formatPortLabel(port),
      })),
    [ports, formatPortLabel]
  );

  const resetForm = useCallback(() => {
    setForm(INITIAL_FORM);
    setFormError('');
    setEditingPort(null);
  }, []);

  const handleInputChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleEdit = (port) => {
    setEditingPort(port.portNumber);
    setForm({
      portNumber: String(port.portNumber),
      country: port.country || '',
      countryShort: port.countryShort || '',
      provider: port.provider || '',
      providerShort: port.providerShort || '',
    });
    setFormError('');
  };

  const handleDelete = async (portNumber) => {
    if (!window.confirm(`Delete port ${portNumber}?`)) {
      return;
    }
    try {
      const response = await fetch(`/api/ports/${portNumber}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Delete failed (${response.status})`);
      }
      await fetchPorts();
      if (editingPort === portNumber) {
        resetForm();
      }
    } catch (err) {
      console.error('❌ Failed to delete port:', err);
      setError(err.message || 'Failed to delete port');
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!form.portNumber || !form.country || !form.countryShort || !form.provider || !form.providerShort) {
      setFormError('All fields are required.');
      return;
    }
    const portNumber = Number(form.portNumber);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      setFormError('Port number must be a positive number.');
      return;
    }

    setSubmitting(true);
    setFormError('');
    try {
      const response = await fetch('/api/ports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portNumber,
          country: form.country,
          countryShort: form.countryShort.toUpperCase(),
          provider: form.provider,
          providerShort: form.providerShort.toUpperCase(),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Save failed (${response.status})`);
      }
      await fetchPorts();
      resetForm();
    } catch (err) {
      console.error('❌ Failed to save port:', err);
      setFormError(err.message || 'Failed to save port');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-content ports-panel">
      <header className="ports-header">
        <div>
          <h1>Ports</h1>
          <p className="ports-subtitle">
            Manage proxy ports, country/ISP labels, and enable measurement pipelines for new regions.
          </p>
        </div>
        <button type="button" onClick={fetchPorts} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {error && <div className="ports-banner warning">{error}</div>}

      <div className="ports-content">
        <section className="ports-list-section">
          <h2>Configured Ports</h2>
          {sortedPorts.length === 0 ? (
            <div className="ports-placeholder">No ports configured yet.</div>
          ) : (
            <table className="ports-table">
              <thead>
                <tr>
                  <th>Port</th>
                  <th>Country</th>
                  <th>Country Short</th>
                  <th>Provider</th>
                  <th>Provider Short</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sortedPorts.map((port) => (
                  <tr key={port.portNumber}>
                    <td>{port.portNumber}</td>
                    <td>{port.country}</td>
                    <td>{port.countryShort}</td>
                    <td>{port.provider}</td>
                    <td>{port.providerShort}</td>
                    <td className="ports-actions">
                      <button type="button" onClick={() => handleEdit(port)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => handleDelete(port.portNumber)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="ports-form-section">
          <h2>{editingPort ? `Update Port ${editingPort}` : 'Add Port'}</h2>
          <form className="ports-form" onSubmit={handleSubmit}>
            <label>
              Port number
              <input
                name="portNumber"
                type="number"
                min="1"
                value={form.portNumber}
                onChange={handleInputChange}
                required
                disabled={submitting}
              />
            </label>
            <label>
              Country
              <input
                name="country"
                type="text"
                value={form.country}
                onChange={handleInputChange}
                required
                disabled={submitting}
              />
            </label>
            <label>
              Country short
              <input
                name="countryShort"
                type="text"
                value={form.countryShort}
                onChange={handleInputChange}
                required
                disabled={submitting}
              />
            </label>
            <label>
              Provider
              <input
                name="provider"
                type="text"
                value={form.provider}
                onChange={handleInputChange}
                required
                disabled={submitting}
              />
            </label>
            <label>
              Provider short
              <input
                name="providerShort"
                type="text"
                value={form.providerShort}
                onChange={handleInputChange}
                required
                disabled={submitting}
              />
            </label>
            {formError && <div className="ports-banner warning">{formError}</div>}
            <div className="ports-form-actions">
              <button type="submit" disabled={submitting}>
                {submitting ? 'Saving…' : editingPort ? 'Update Port' : 'Add Port'}
              </button>
              {editingPort && (
                <button
                  type="button"
                  className="secondary"
                  onClick={resetForm}
                  disabled={submitting}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
};

export default PortsPanel;


