// import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
// import fs from 'fs';

// async function createTestPdf() {
//   try {
//     const pdfDoc = await PDFDocument.create();
//     const page = pdfDoc.addPage([1000, 600]);
//     const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
//     const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

//     const headers = ['Document', 'Entry Date', 'Delivery Date', 'Customer Name', 'Item Desc', 'Qty', 'PO Document', 'Order Notes'];
//     const data = [
//       ['ORD-001', '2024-05-01', '2024-05-05', 'Cambridge Garden Centre', '3/4 Clear Gravel (MT)', '15.5', 'PO-1001', 'Priority'],
//       ['ORD-002', '2024-05-02', '2024-05-06', 'Build-It Construction', 'Screened Topsoil (CY)', '20', 'PO-1002', 'Gate code 1234'],
//       ['ORD-003', '2024-05-03', '2024-05-07', 'Green Landscapes', 'River Stone 2-5 inch (MT)', '12.25', 'PO-1003', 'Deliver to back'],
//       ['ORD-004', '2024-05-04', '2024-05-08', 'City Parks Dept', 'Mulch Black (CY)', '40', 'PO-1004', 'Contact John'],
//       ['ORD-005', '2024-05-05', '2024-05-09', 'Acme Developments', 'Premium Soil Mix (CY)', '30', 'PO-1005', 'N/A'],
//     ];

//     let y = 550;
//     const xOffsets = [20, 100, 180, 260, 450, 600, 700, 850];

//     // Draw Title
//     page.drawText('Spruce Order Export - Test Data', {
//       x: 20,
//       y: 580,
//       size: 14,
//       font: boldFont,
//     });

//     // Draw Table Headers
//     headers.forEach((header, i) => {
//       page.drawText(header, {
//         x: xOffsets[i],
//         y: y,
//         size: 10,
//         font: boldFont,
//       });
//     });

//     // Draw a line under headers
//     page.drawLine({
//       start: { x: 20, y: y - 5 },
//       end: { x: 980, y: y - 5 },
//       thickness: 1,
//       color: rgb(0, 0, 0),
//     });

//     y -= 25;

//     // Draw Data Rows
//     data.forEach((row) => {
//       row.forEach((text, i) => {
//         page.drawText(text, {
//           x: xOffsets[i],
//           y: y,
//           size: 9,
//           font: font,
//         });
//       });
//       y -= 20;
//     });

//     const pdfBytes = await pdfDoc.save();
//     fs.writeFileSync('test_data/test_order_import.pdf', pdfBytes);
//     console.log('Successfully generated test_data/test_order_import.pdf');
//   } catch (error) {
//     console.error('Error generating PDF:', error);
//   }
// }

// createTestPdf();
