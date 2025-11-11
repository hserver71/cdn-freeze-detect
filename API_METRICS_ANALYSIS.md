# `/api/metrics` Endpoint Analysis

## Overview
The `/api/metrics` endpoint is designed to receive and store server metrics (CPU, memory, disk I/O, Nginx requests) from monitoring agents or external servers.

## Current Implementation

### Endpoint Details
- **Method**: `POST`
- **Path**: `/api/metrics`
- **Location**: `backend/index.js` (lines 420-481)
- **Status**: ⚠️ **INCOMPLETE** - Missing database table definition

### Request Body Schema
```json
{
  "server": "string (required)",           // Server identifier/IP
  "timestamp": "number (required)",        // Unix timestamp
  "cpu_usage": "number (optional)",        // CPU usage percentage
  "mem_usage": "number (optional)",        // Memory usage percentage
  "disk_read_mb": "number (optional)",     // Total disk read in MB
  "disk_write_mb": "number (optional)",   // Total disk write in MB
  "disk_read_mb_per_min": "number (optional)",  // Disk read rate MB/min
  "disk_write_mb_per_min": "number (optional)", // Disk write rate MB/min
  "nginx_request_count_per_min": "number (optional)" // Nginx requests/min
}
```

### Response Format
**Success (200)**:
```json
{
  "success": true,
  "message": "Metrics saved successfully",
  "server": "192.168.1.100",
  "timestamp": 1234567890
}
```

**Error (400)**:
```json
{
  "success": false,
  "error": "Missing required fields: server or timestamp"
}
```

**Error (500)**:
```json
{
  "success": false,
  "error": "Failed to save metrics"
}
```

## Issues Identified

### 🚨 Critical Issue: Missing Database Table
The `server_metrics` table is **NOT** defined in `backend/config/database.js`. The endpoint will fail when trying to INSERT data.

### Current Database Schema (Expected)
The endpoint expects a table with this structure:
- `id` (AUTO_INCREMENT PRIMARY KEY)
- `server` (VARCHAR) - Server identifier
- `timestamp` (DATETIME) - Converted from Unix timestamp
- `cpu_usage` (DECIMAL)
- `mem_usage` (DECIMAL)
- `disk_read_mb` (DECIMAL)
- `disk_write_mb` (DECIMAL)
- `disk_read_mb_per_min` (DECIMAL)
- `disk_write_mb_per_min` (DECIMAL)
- `nginx_request_count_per_min` (DECIMAL)

## Recommendations

### 1. Add Missing Table Definition
Add `server_metrics` table creation to `backend/config/database.js`

### 2. Add GET Endpoint
Create a GET endpoint to retrieve metrics:
- `/api/metrics` - Get all metrics with filters
- `/api/metrics/:server` - Get metrics for specific server
- Query params: `?startTime=X&endTime=Y&limit=100`

### 3. Add Metrics Controller
Move logic from `index.js` to a dedicated `MetricsController` for better organization.

### 4. Add Validation
- Validate timestamp format
- Validate numeric ranges (0-100 for percentages)
- Validate server identifier format

### 5. Add Indexing
Create indexes on `server` and `timestamp` columns for faster queries.

### 6. Add Time-based Cleanup
Implement automatic cleanup of old metrics (e.g., delete records older than 30 days).

## Example Usage

### Sending Metrics
```bash
curl -X POST http://localhost:5000/api/metrics \
  -H "Content-Type: application/json" \
  -d '{
    "server": "192.168.1.100",
    "timestamp": 1704067200,
    "cpu_usage": 45.5,
    "mem_usage": 62.3,
    "disk_read_mb": 1024.5,
    "disk_write_mb": 512.2,
    "disk_read_mb_per_min": 10.5,
    "disk_write_mb_per_min": 5.2,
    "nginx_request_count_per_min": 150
  }'
```

## Integration Points
This endpoint is likely called by:
- External monitoring agents/scripts
- Server-side cron jobs collecting system metrics
- Infrastructure monitoring tools

