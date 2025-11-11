import React from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  TimeScale
} from 'chart.js';
import 'chartjs-adapter-date-fns';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  TimeScale
);

const BandwidthChart = ({ title, subtitle, data, isLoading, avgBandwidth }) => {
  const chartRef = React.useRef(null);

  if (!data || data.length === 0) {
    return (
      <div className="chart-container">
        <div className="chart-loading">No data available for {title}</div>
      </div>
    );
  }

  // Convert UTC timestamps to local browser time for display
  const chartData = {
    labels: data.map(item => {
      const date = new Date(item.timestamp);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }),
    datasets: [
      {
        label: `Upload`,
        data: data.map(item => item.bandwidth),
        borderColor: 'rgb(75, 192, 192)',
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        tension: 0.1,
        pointRadius: 0,
        pointHoverRadius: 3
      }
    ]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'top',
      },
      tooltip: {
        callbacks: {
          title: (context) => {
            const date = new Date(data[context[0].dataIndex].timestamp);
            return date.toLocaleString([], {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            });
          },
          label: (context) => {
            return `Bandwidth: ${context.parsed.y.toFixed(2)}`;
          }
        }
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: 'Upload Bandwidth'
        }
      },
      x: {
        title: { display: true, text: 'Time (Local)' },
        ticks: {
          maxTicksLimit: 10, // Show maximum 10 labels to avoid crowding
          callback: function(value, index) {
            // Show time in local format
            const date = new Date(data[index].timestamp);
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }
        }
      }
    }
  };

  if (isLoading) {
    return (
      <div className="chart-container">
        <div className="chart-loading">Loading chart for {title}...</div>
      </div>
    );
  }

  return (
    <div className="chart-container" style={{ height: '400px', minHeight: '400px' }}>
      <div className="chart-header">
        <div className="chart-title-block">
          <span className="ip-address">
            {title}
          </span>
          {subtitle && (
            <span className="chart-subtitle">{subtitle}</span>
          )}
        </div>
        <span className="avg-bandwidth">Avg: {Number(avgBandwidth || 0).toFixed(2)}</span>
      </div>
      <div className="chart-wrapper" style={{ height: '350px', position: 'relative' }}>
        <Line ref={chartRef} data={chartData} options={options} />
      </div>
    </div>
  );
};

export default BandwidthChart;