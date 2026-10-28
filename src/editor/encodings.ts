// Encodings the user can pick. Ids are encoding_rs names in lower case.

export interface EncodingChoice {
  id: string;
  label: string;
  /** Add a BOM when saving (UTF-8 with BOM). */
  bom?: boolean;
  /** Only for opening. The Rust side cannot write this encoding. */
  readOnly?: boolean;
}

export const ENCODINGS: EncodingChoice[] = [
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'utf-8', label: 'UTF-8 with BOM', bom: true },
  { id: 'utf-16le', label: 'UTF-16 LE' },
  { id: 'utf-16be', label: 'UTF-16 BE' },
  { id: 'windows-1252', label: 'Western (Windows 1252)' },
  { id: 'iso-8859-2', label: 'Central European (ISO 8859-2)' },
  { id: 'iso-8859-15', label: 'Western (ISO 8859-15)' },
  { id: 'windows-1250', label: 'Central European (Windows 1250)' },
  { id: 'windows-1251', label: 'Cyrillic (Windows 1251)' },
  { id: 'koi8-r', label: 'Cyrillic (KOI8-R)' },
  { id: 'windows-1253', label: 'Greek (Windows 1253)' },
  { id: 'windows-1254', label: 'Turkish (Windows 1254)' },
  { id: 'windows-1255', label: 'Hebrew (Windows 1255)' },
  { id: 'windows-1256', label: 'Arabic (Windows 1256)' },
  { id: 'windows-1258', label: 'Vietnamese (Windows 1258)' },
  { id: 'windows-874', label: 'Thai (Windows 874)' },
  { id: 'macintosh', label: 'Western (Mac Roman)' },
  { id: 'shift_jis', label: 'Japanese (Shift JIS)' },
  { id: 'euc-jp', label: 'Japanese (EUC-JP)' },
  { id: 'iso-2022-jp', label: 'Japanese (ISO-2022-JP)', readOnly: true },
  { id: 'gbk', label: 'Simplified Chinese (GBK)' },
  { id: 'gb18030', label: 'Chinese (GB18030)' },
  { id: 'big5', label: 'Traditional Chinese (Big5)' },
  { id: 'euc-kr', label: 'Korean (EUC-KR)' },
];

/** Text for the status bar, for example `UTF-8 with BOM`. */
export function encodingLabel(encoding: string, bom: boolean): string {
  const key = encoding.toLowerCase();
  if (key === 'utf-8') return bom ? 'UTF-8 with BOM' : 'UTF-8';
  const found = ENCODINGS.find((e) => e.id === key);
  return found ? found.label : encoding.toUpperCase();
}
