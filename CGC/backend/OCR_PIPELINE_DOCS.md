# Automatic OCR Pipeline Documentation

## Overview

The automatic OCR pipeline has been implemented to process tickets and extract data automatically as soon as they arrive via WhatsApp or email. No manual intervention is required to trigger OCR processing.

## Architecture

### Flow Diagram

```
Ticket Received
    ↓
Create Ticket Record
    ↓
Create OCR Job (PENDING)
    ↓
Trigger OCR Processing (Async, Non-blocking)
    ↓
Extract Text from Image (AWS Textract)
    ↓
Parse Extracted Data
    ↓
Auto-link to Order (if PO number matches exactly one order)
    ↓
Update Ticket & Mark OCR Job as COMPLETED
    ↓
Error Handling → Mark OCR Job as FAILED with error message
```

## Components

### 1. **OCR Job Processor** (`src/services/ocrJobProcessor.ts`)

The core service that handles automatic OCR processing:

- **`processOcrJob(jobId)`** - Processes a single OCR job
  - Updates job status to PROCESSING
  - Extracts text from the image
  - Auto-links to orders if PO number matches
  - Handles errors gracefully
  - Updates job status to COMPLETED or FAILED

- **`processPendingOcrJobs()`** - Processes all pending OCR jobs
  - Used as a fallback for any jobs that failed to process automatically
  - Can be called periodically or manually

- **`triggerOcrProcessing(jobId)`** - Initiates processing asynchronously
  - Uses `setImmediate()` to process in the next event loop iteration
  - Non-blocking - returns immediately to the API caller
  - Includes error handling to prevent unhandled promise rejections

### 2. **Ticket Service Updates** (`src/modules/tickets/ticket.service.ts`)

Modified to automatically trigger OCR processing:

- `ingestWhatsappTicket()` - Now calls `triggerOcrProcessing()` after creating OCR job
- `ingestEmailTicket()` - Now calls `triggerOcrProcessing()` after creating OCR job

### 3. **New API Endpoints** (`src/modules/tickets/ticket.routes.ts`)

- **GET `/api/tickets/:ticketId/ocr-status`**
  - Returns the most recent OCR job status for a ticket
  - Shows: status, timestamps, extracted data, errors

- **POST `/api/tickets/jobs/process-pending`**
  - Manually triggers processing of all pending OCR jobs
  - Returns number of jobs processed
  - Useful for debugging or manual intervention

## How It Works

### 1. Ticket Ingestion (WhatsApp/Email)

```typescript
// User uploads a ticket via WhatsApp or email
POST /api/tickets/whatsapp or POST /api/tickets/email
```

**Response (Immediate - max 1-2 seconds):**
```json
{
  "message": "WhatsApp ticket received and queued for OCR",
  "ticket": { /* ticket data */ },
  "ocrJobId": "job_xxx"
}
```

### 2. Background OCR Processing (Automatic)

Once the API returns, the OCR processing begins in the background:

1. AWS Textract extracts text from the image
2. Data is parsed to extract:
   - Supplier name
   - Ticket date
   - Material type
   - Quantity
   - PO number
   - Ticket number
   - Confidence score

3. Auto-linking logic:
   - If a PO number is found and exactly ONE matching order exists → Auto-link
   - If multiple orders match → Remain UNLINKED (avoid incorrect linking)
   - If no PO number → Remain UNLINKED

4. Ticket status updated:
   - `LINKED` - if auto-linked to an order
   - `UNLINKED` - if no match found

### 3. Error Handling

If OCR processing fails:
- OCR job marked as `FAILED`
- Error message stored for debugging
- Ticket remains in `UNLINKED` status with previous data
- Can be retried manually via `/jobs/process-pending` endpoint

## Database Schema Impact

### OcrJob Table Fields

```typescript
enum OcrJobStatus {
  PENDING      // Initial state, waiting to be processed
  PROCESSING   // Currently being processed
  COMPLETED    // Successfully processed
  FAILED       // Error during processing
}

id: string              // Unique ID
type: TICKET | INVOICE  // Job type
provider: AWS_TEXTRACT  // OCR provider
status: OcrJobStatus    // Current status
ticketId: string        // Link to ticket
createdAt: DateTime     // Created timestamp
startedAt: DateTime     // Processing started timestamp
finishedAt: DateTime    // Processing finished timestamp
rawResponse: Object     // Extracted data (JSON)
errorMessage: string    // Error details if failed
```

## Usage Examples

### Example 1: Automatic OCR Processing

```bash
# User uploads a ticket (automatic processing happens in background)
curl -X POST http://localhost:3000/api/tickets/whatsapp \
  -H "Content-Type: multipart/form-data" \
  -F "file=@ticket.jpg" \
  -F "fromPhone=+2348123456789"

# Response (immediate):
{
  "message": "WhatsApp ticket received and queued for OCR",
  "ticket": {
    "id": "ticket_123",
    "imageUrl": "/uploads/tickets/...",
    "status": "UNLINKED",
    "ocrRawText": ""  // Empty initially
  },
  "ocrJobId": "job_456"
}

# After 2-5 seconds (background processing completes):
# Ticket automatically gets updated with OCR data and potentially linked to an order
```

### Example 2: Check OCR Job Status

```bash
curl http://localhost:3000/api/tickets/ticket_123/ocr-status

# Response:
{
  "id": "job_456",
  "status": "COMPLETED",
  "startedAt": "2026-04-14T10:30:00Z",
  "finishedAt": "2026-04-14T10:30:05Z",
  "rawResponse": {
    "rawText": "...",
    "supplierName": "Galt Gravel",
    "ticketDate": "2026-04-14",
    "material": "sand",
    "quantity": 50,
    "poNumber": "PO-12345",
    "ticketNumber": "TKT-001",
    "ocrConfidence": 92.5
  }
}
```

### Example 3: Manually Process Pending Jobs

```bash
curl -X POST http://localhost:3000/api/tickets/jobs/process-pending

# Response:
{
  "message": "Started processing 3 pending OCR jobs",
  "jobsProcessed": 3
}
```

## Configuration

### Environment Variables

No new environment variables required. Uses existing AWS credentials in `.env`:

```
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx
```

### Performance Tuning

1. **Processing Timeout**: Currently uses `setImmediate()` which processes in next event loop
   - For large bursts, consider adding queue system (Bull, BullMQ)
   - Current setup handles up to ~10 concurrent tickets well

2. **Error Retry**: Failed jobs can be retried via `/jobs/process-pending` endpoint
   - Consider adding exponential backoff in production

3. **Logging**: All OCR operations logged with `[OCR]` prefix
   - View logs: `grep "\[OCR\]" <logfile>`

## Benefits

1. **No Manual Action Required** - Tickets automatically processed
2. **Fast API Response** - Ingestion endpoint returns immediately
3. **Async Processing** - Doesn't block other requests
4. **Auto-Linking** - Tickets automatically linked to matching orders
5. **Error Resilience** - Failed jobs can be retried
6. **Monitoring Friendly** - Status endpoint to check progress
7. **Fallback Mechanism** - Manual job processor for recovery

## Monitoring & Debugging

### Check System Health

```bash
# Get OCR job status
curl http://localhost:3000/api/tickets/{ticketId}/ocr-status

# View application logs (look for [OCR] prefix)
tail -f logs/app.log | grep "\[OCR\]"
```

### Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| OCR job stuck in PENDING | Run `/jobs/process-pending` endpoint |
| Ticket not auto-linked | Check PO number extraction, verify order exists |
| AWS Textract errors | Verify AWS credentials, check image format |
| High OCR failure rate | Review image quality, check CloudWatch logs |

## Future Enhancements

1. **Job Queue System** (Bull/BullMQ) - Better for high volume
2. **Scheduled Retry** - Automatic retry of failed jobs
3. **Webhook Notifications** - Notify when OCR completes
4. **Batch Processing** - Optimize for bulk ticket imports
5. **Confidence Threshold** - Only auto-link if confidence > X%
6. **Manual Review Queue** - Flag uncertain extractions for review

## Testing

### Test Automatic OCR Pipeline

```bash
#!/bin/bash

# 1. Upload a test ticket
RESPONSE=$(curl -s -X POST http://localhost:3000/api/tickets/whatsapp \
  -H "Content-Type: multipart/form-data" \
  -F "file=@test_ticket.jpg" \
  -F "fromPhone=+2348123456789")

TICKET_ID=$(echo $RESPONSE | jq '.ticket.id' -r)
JOB_ID=$(echo $RESPONSE | jq '.ocrJobId' -r)

echo "Created ticket: $TICKET_ID, Job: $JOB_ID"

# 2. Wait for background processing
sleep 3

# 3. Check OCR job status
curl http://localhost:3000/api/tickets/$TICKET_ID/ocr-status | jq .

# 4. Get updated ticket details
curl http://localhost:3000/api/tickets/$TICKET_ID | jq '.ocrRawText, .status'
```

---

**Last Updated:** April 14, 2026
**Status:** Production Ready ✅
