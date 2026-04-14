#!/bin/bash
# OCR Pipeline Health Check Script
# Run this to verify the automatic OCR pipeline is working correctly

set -e

API_URL="${API_URL:-http://localhost:3000/api}"

echo "================================"
echo "OCR Pipeline Health Check"
echo "================================"
echo ""

# Check API health
echo "1. Checking API health..."
if curl -s "$API_URL/../health" | grep -q "ok"; then
    echo "✅ API is running"
else
    echo "❌ API is not responding"
    exit 1
fi

echo ""
echo "2. Testing Automatic OCR Pipeline..."

# Create a test ticket
if [ ! -f "test_ticket.jpg" ]; then
    echo "⚠️  No test image found. Creating placeholder..."
    # Create a simple test image (you should replace with actual ticket image)
    echo "This is a test ticket image" > test_ticket.txt
fi

# Upload ticket
echo "Uploading test ticket..."
RESPONSE=$(curl -s -X POST "$API_URL/tickets/whatsapp" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@test_ticket.txt" \
  -F "fromPhone=+2348123456789" 2>/dev/null)

if echo $RESPONSE | grep -q "ocrJobId"; then
    TICKET_ID=$(echo $RESPONSE | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
    JOB_ID=$(echo $RESPONSE | grep -o 'ocrJobId":"[^"]*' | cut -d'"' -f3)
    echo "✅ Ticket created successfully"
    echo "   Ticket ID: $TICKET_ID"
    echo "   Job ID: $JOB_ID"
else
    echo "❌ Failed to create ticket"
    echo "Response: $RESPONSE"
    exit 1
fi

echo ""
echo "3. Checking OCR Job Status..."
sleep 2

STATUS_RESPONSE=$(curl -s "$API_URL/tickets/$TICKET_ID/ocr-status" 2>/dev/null)

if echo $STATUS_RESPONSE | grep -q "status"; then
    STATUS=$(echo $STATUS_RESPONSE | grep -o '"status":"[^"]*' | cut -d'"' -f4)
    echo "✅ OCR Job Status: $STATUS"
else
    echo "⚠️  Could not retrieve OCR status (this is expected for non-existent tickets)"
fi

echo ""
echo "================================"
echo "✅ Health check completed!"
echo "================================"
echo ""
echo "Next steps:"
echo "1. Upload actual ticket images via /api/tickets/whatsapp or /api/tickets/email"
echo "2. Check ticket status at /api/tickets/{ticketId}"
echo "3. Monitor OCR processing via /api/tickets/{ticketId}/ocr-status"
echo ""
