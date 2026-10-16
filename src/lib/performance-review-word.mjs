const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_R = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES = XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
const ROOT_RELS = XML + `<Relationships xmlns="${PACKAGE_R}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOCUMENT_RELS = XML + `<Relationships xmlns="${PACKAGE_R}"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/></Relationships>`;
const STYLES = XML + `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial"/><w:color w:val="263545"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/><w:color w:val="263545"/></w:rPr></w:style></w:styles>`;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(parts) {
  const encoder = new TextEncoder();
  const localChunks = [];
  const directoryChunks = [];
  let offset = 0;
  let directorySize = 0;
  for (const [path, text] of parts) {
    const name = encoder.encode(path);
    const data = encoder.encode(text);
    const checksum = crc32(data);
    const local = new Uint8Array(30);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(12, 0x0021, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    localChunks.push(local, name, data);
    const directory = new Uint8Array(46);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014b50, true);
    directoryView.setUint16(4, 20, true);
    directoryView.setUint16(6, 20, true);
    directoryView.setUint16(8, 0x0800, true);
    directoryView.setUint16(14, 0x0021, true);
    directoryView.setUint32(16, checksum, true);
    directoryView.setUint32(20, data.length, true);
    directoryView.setUint32(24, data.length, true);
    directoryView.setUint16(28, name.length, true);
    directoryView.setUint32(42, offset, true);
    directoryChunks.push(directory, name);
    offset += local.length + name.length + data.length;
    directorySize += directory.length + name.length;
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, parts.length, true);
  endView.setUint16(10, parts.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  const bytes = new Uint8Array(offset + directorySize + end.length);
  let cursor = 0;
  for (const chunk of [...localChunks, ...directoryChunks, end]) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  return bytes;
}

function escapeXml(value) {
  return value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function paragraph(value,{bold=false,size=22,color='263545',before=0,after=60,keep=false}={}) {
  const text=String(value??'').replace(/\r\n?/g,'\n').split(/(\n|\t)/).map(part=>part==='\n'?'<w:br/>':part==='\t'?'<w:tab/>':`<w:t xml:space="preserve">${escapeXml(part)}</w:t>`).join('');
  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/>${keep?'<w:keepNext/>':''}</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>${bold?'<w:b/>':''}<w:sz w:val="${size}"/><w:color w:val="${color}"/></w:rPr>${text}</w:r></w:p>`;
}
function cell(value,width,{fill='FFFFFF',bold=false,color='263545',size=22}={}) {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/><w:vAlign w:val="top"/></w:tcPr>${paragraph(value,{bold,color,size,after:0})}</w:tc>`;
}
function table(widths,rows,{header=false,minHeight=0}={}) {
  const body=rows.map((row,index)=>`<w:tr><w:trPr>${header&&index===0?'<w:tblHeader/>':''}${minHeight&&!(header&&index===0)?`<w:trHeight w:val="${minHeight}" w:hRule="atLeast"/>`:''}</w:trPr>${row.map((entry,col)=>cell(entry.text,widths[col],entry)).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="14822" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B9C7D3"/><w:left w:val="single" w:sz="4" w:color="B9C7D3"/><w:bottom w:val="single" w:sz="4" w:color="B9C7D3"/><w:right w:val="single" w:sz="4" w:color="B9C7D3"/><w:insideH w:val="single" w:sz="4" w:color="B9C7D3"/><w:insideV w:val="single" w:sz="4" w:color="B9C7D3"/></w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(width=>`<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${body}</w:tbl>`;
}
const white=text=>({text});
const blue=text=>({text,fill:'E9F3FA'});
const yellow=text=>({text,fill:'FFF6D8'});
const heading=text=>({text,bold:true,color:'FFFFFF',fill:'23374D'});
const label=text=>({text,bold:true});
const RATED=[0,1,2,6,7,8,9];

export function buildReviewDocx(review,questions) {
  if(!review||!['MAM','Equipsy'].includes(review.employee?.company)||!Array.isArray(questions)||questions.length!==12||!questions.every(x=>typeof x==='string'))throw new Error('A supported HR template and its twelve prompts are required.');
  if(review.audience!==undefined&&!['employee','manager','admin'].includes(review.audience))throw new Error('The Word audience is invalid.');
  const employeeOnly=review.audience==='employee',company=review.employee.company;
  const meeting=employeeOnly?null:review.meeting;
  const body=[paragraph(`${company} Performance review`,{bold:true,size:32,keep:true}),
    paragraph('SYNTHETIC TEST ONLY — no real employee information.',{size:18,color:'526275'}),
    paragraph(employeeOnly?'Blue = employee responses. Employee copy — self-assessment only.':'Blue = employee responses. Yellow = manager input. Manager copy — do not share with employees.',{size:20,color:'526275'})];
  const metadata=[
    [label('Employee'),white(review.employee.name),label('Role'),white(review.employee.jobTitle)],
    [label('Manager'),white(review.manager.name),label('Review ID'),white(review.code)],
    [label('Review period'),white(review.cycle),label('Company'),white(company)],
    [label('Team'),white(review.employee.team),label(employeeOnly?'Copy':'Meeting date and time'),white(employeeOnly?'Employee':meeting?`${meeting.date} ${meeting.time}`:'')]
  ];
  body.push(table([2100,5311,2100,5311],metadata),paragraph(''));
  if(!employeeOnly)body.push(paragraph('Ratings: 1 Needs improvement | 2 Meets expectations | 3 Exceeds expectations | N Not enough evidence',{size:20,color:'526275'}));
  const rows=[(employeeOnly?['Area and prompt','Employee response']:['Area and prompt','Employee response','Manager feedback and evidence','Manager rating']).map(heading)];
  questions.forEach((question,index)=>{
    const row=[white(question),blue(review.selfAnswers[index])];
    if(!employeeOnly)row.push(yellow(review.managerAnswers[index]),yellow(RATED.includes(index)?review.ratings[index]:''));
    rows.push(row);
  });
  if(!employeeOnly)rows.push([label('Overall manager assessment\nExplain the overall rating using results and behaviours together. Do not calculate an automatic average.'),white(''),yellow(review.summary),yellow(review.overallRating)]);
  body.push(table(employeeOnly?[5000,9822]:[3588,4525,4525,2184],rows,{header:true,minHeight:1000}));
  body.push(paragraph('Preserve original employee responses. Record corrections as dated notes; do not overwrite them.',{size:18,color:'526275',before:100}));
  if(!employeeOnly){
    body.push(paragraph('1 = important requirements not consistently met. 2 = reliable performance at the expected standard.',{size:18,color:'526275'}),
      paragraph('3 = sustained contribution above the expected standard, supported by examples. N = insufficient evidence; arrange follow-up.',{size:18,color:'526275'}),
      paragraph('Assess the whole period fairly. Consider agreed hours, support and factors outside the employee’s control.',{size:18,color:'526275'}),
      paragraph('Goals and meeting record',{bold:true,size:28,before:240,keep:true}),
      paragraph('Structured goal details are not captured separately in this test version. The goal table is intentionally blank; no goals or dates have been inferred.',{size:18,color:'526275'}));
    const goals=[['Priority','Measure of success','Support and responsible person','Due date','Progress check'].map(heading),...Array.from({length:3},()=>Array.from({length:5},()=>yellow('')))];
    body.push(table([2450,5050,3420,2000,1902],goals,{header:true,minHeight:700}),paragraph(''));
    const details=[
      [label('Meeting date'),yellow(meeting?.date??''),label('Time'),yellow(meeting?.time??'')],
      [label('Duration'),yellow(meeting?`${meeting.duration} minutes`:''),label('Mode'),yellow(meeting?.mode??'')],
      [label('Location'),yellow(meeting?.location??''),label('Overall rating'),yellow(review.overallRating)]
    ];
    body.push(table([2100,5311,2100,5311],details),paragraph('Meeting notes',{bold:true,before:120,keep:true}),table([14822],[[yellow(meeting?.notes??'')]],{minHeight:900}),paragraph('Meeting registration does not confirm that the meeting was held.',{size:18,color:'526275'}));
  }
  const document=XML+`<w:document xmlns:w="${W}"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1080" w:right="1008" w:bottom="1080" w:left="1008" w:header="432" w:footer="432" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zip([['[Content_Types].xml',CONTENT_TYPES],['_rels/.rels',ROOT_RELS],['word/document.xml',document],['word/_rels/document.xml.rels',DOCUMENT_RELS],['word/styles.xml',STYLES]]);
}
