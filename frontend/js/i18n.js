/* ══════════════════════════════════════════════════════════════════════════════
   PetroKenya — Kiswahili translation
   The page is written in English. When Kiswahili is chosen, every piece of text
   that matches the dictionary below is swapped as the page draws, including text
   the app adds later (toasts, lists, status labels). Names, numbers and anything
   people type are never changed. Official KRA tax terms stay in English.
   ══════════════════════════════════════════════════════════════════════════════ */

const LANG_KEY = 'pk_lang';
const LANG = (() => { try { return localStorage.getItem(LANG_KEY) === 'sw' ? 'sw' : 'en'; } catch (e) { return 'en'; } })();
document.documentElement.lang = LANG;
const LOCALE = LANG === 'sw' ? 'sw-KE' : 'en-KE';   // for dates

function setLanguage(lang) {
  try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* storage blocked: stays as is */ }
  location.reload();
}

const SW = {
  // ── Header, sign-in, status ──
  'STATION MANAGEMENT SYSTEM': 'MFUMO WA USIMAMIZI WA KITUO',
  'Engine Ready': 'Tayari', 'Engine Active': 'Inafanya kazi', 'Calculating…': 'Inakokotoa…',
  'Connecting…': 'Inaunganisha…', 'Online · Synced': 'Mtandaoni · Imesawazishwa',
  'Offline · Saving on this phone': 'Nje ya mtandao · Inahifadhi kwenye simu hii',
  'Sign in': 'Ingia', 'Sign out': 'Toka', 'Install': 'Sakinisha', 'Username': 'Jina la mtumiaji',
  'Password': 'Nenosiri', 'Ask your administrator for an account.': 'Omba akaunti kutoka kwa msimamizi wako.',
  'Wrong username or password': 'Jina la mtumiaji au nenosiri si sahihi',
  'Too many failed attempts — try again in 15 minutes': 'Majaribio mengi yameshindwa — jaribu tena baada ya dakika 15',
  'This account is paused for 15 minutes after too many wrong passwords':
    'Akaunti hii imesimamishwa kwa dakika 15 baada ya manenosiri mengi yasiyo sahihi',
  'Please sign in': 'Tafadhali ingia', 'You are offline. Connect to the internet to sign in.':
    'Uko nje ya mtandao. Unganisha intaneti ili uingie.',
  'Language': 'Lugha', 'Lugha / Language': 'Lugha / Language',

  // ── Top bar and summary ──
  'DATE': 'TAREHE', 'STATION': 'TAWI', 'OPERATOR': 'MHUDUMU', 'SHIFT': 'ZAMU',
  'Day Shift (06:00–18:00)': 'Zamu ya Mchana (06:00–18:00)', 'Night Shift (18:00–06:00)': 'Zamu ya Usiku (18:00–06:00)',
  'Full Day': 'Siku Nzima', 'Sign in to fill': 'Ingia ili ijazwe', 'Filled in from the signed-in account': 'Hujazwa kutoka akaunti iliyoingia',
  'Live Summary — auto-calculated every keystroke': 'Muhtasari — hukokotolewa kila unapoandika',
  'Total Sales': 'Jumla ya Mauzo', 'Kenyan Shillings (KES)': 'Shilingi za Kenya (KES)', 'Awaiting fuel data…': 'Inasubiri data ya mafuta…',
  'Litres Sold': 'Lita Zilizouzwa', 'Total Litres': 'Jumla ya Lita', 'M-Pesa Received': 'M-Pesa Iliyopokelewa',
  'Safaricom Mobile Money': 'Pesa ya simu ya Safaricom', '0 transactions': 'Miamala 0', 'Cash at Hand': 'Pesa Taslimu Mkononi',
  'Physical Cash': 'Pesa taslimu', 'Till + float': 'Droo + akiba', 'Daily Expenses': 'Matumizi ya Siku',
  'Operating Costs': 'Gharama za uendeshaji', 'Net Profit': 'Faida Halisi', 'Daily Net': 'Faida ya siku',
  'KRA Tax Payable': 'Kodi ya KRA Inayolipwa', 'VAT + Excise': 'VAT + Ushuru', 'Revenue / Litre': 'Mapato kwa Lita',
  'Efficiency': 'Ufanisi',

  // ── Menu and pages ──
  'Sections': 'Sehemu', 'Back': 'Rudi', 'Back to menu': 'Rudi kwenye menyu', 'Save': 'Hifadhi',
  'Fuel Entry': 'Uingizaji wa Mafuta', 'Pump meter readings, prices and litres sold': 'Usomaji wa mita, bei na lita zilizouzwa',
  'Payments': 'Malipo', 'M-Pesa, cash, card and credit collected': 'M-Pesa, pesa taslimu, kadi na mkopo uliokusanywa',
  'Gases & Lubricants': 'Gesi na Vilainishi', 'LPG cylinders, oils and other items sold': 'Mitungi ya gesi, mafuta ya injini na bidhaa nyingine zilizouzwa',
  'Dips': 'Vipimo vya Tanki', 'Tank stock check against pump sales': 'Ukaguzi wa akiba ya tanki dhidi ya mauzo ya pampu',
  'Expenses': 'Matumizi', 'Daily costs and credit customer invoices': 'Gharama za siku na ankara za wateja wa mkopo',
  'KRA Filing': 'Ripoti ya KRA', 'VAT, excise and road levy for the day': 'VAT, ushuru na tozo ya barabara kwa siku',
  'Fuel Prices': 'Bei za Mafuta', 'Selling and cost prices set by the owner': 'Bei za kuuza na kununua zilizowekwa na mmiliki',
  'Credit Accounts': 'Akaunti za Mkopo', 'Customer balances, payments and statements': 'Salio za wateja, malipo na taarifa',
  'Monthly Report': 'Ripoti ya Mwezi', 'Month totals per branch, side by side': 'Jumla za mwezi kwa kila tawi, sambamba',
  'Analytics': 'Takwimu', 'Last 7 days and all-time totals': 'Siku 7 zilizopita na jumla zote',
  'Records': 'Kumbukumbu', 'Saved days for every branch': 'Siku zilizohifadhiwa za kila tawi',

  // ── Fuel entry ──
  'Super Petrol (PMS)': 'Petroli (PMS)', 'Super Petrol': 'Petroli', 'Diesel (AGO)': 'Dizeli (AGO)',
  'Kerosene (IK)': 'Mafuta ya Taa (IK)', 'Petrol (PMS)': 'Petroli (PMS)',
  'Opening Litres Meter (L)': 'Mita ya Lita — Mwanzo (L)', 'Closing Litres Meter (L)': 'Mita ya Lita — Mwisho (L)',
  'Opening Sales Meter (KES)': 'Mita ya Mauzo — Mwanzo (KES)', 'Closing Sales Meter (KES)': 'Mita ya Mauzo — Mwisho (KES)',
  'Selling Price /L (KES)': 'Bei ya Kuuza kwa Lita (KES)', 'Cost Price /L (KES)': 'Bei ya Kununua kwa Lita (KES)',
  'Litres': 'Lita', 'Revenue': 'Mapato', 'Margin': 'Faida', 'Pump Sales Total': 'Jumla ya Mauzo ya Pampu',
  'Variance': 'Tofauti', 'Matches Pump': 'Inalingana na Pampu', 'Fuel Cost': 'Gharama ya Mafuta',
  'Fuel + Gas/Lube revenue': 'Mapato ya mafuta + gesi/vilainishi', 'Cost of fuel sold': 'Gharama ya mafuta yaliyouzwa',
  'Subtracted from sales': 'Imetolewa kwenye mauzo', 'Total Sales − Fuel Cost − Expenses = Net Profit':
    'Jumla ya Mauzo − Gharama ya Mafuta − Matumizi = Faida Halisi',

  // ── Payments ──
  'M-Pesa': 'M-Pesa', 'Amount Received (KES)': 'Kiasi Kilichopokelewa (KES)', 'No. of Transactions': 'Idadi ya Miamala',
  'Till / Paybill No.': 'Namba ya Till / Paybill', 'M-Pesa Ref (last txn)': 'Kumbukumbu ya M-Pesa (muamala wa mwisho)',
  'Cash Collected (KES)': 'Pesa Taslimu Iliyokusanywa (KES)', 'Opening Float (KES)': 'Akiba ya Mwanzo (KES)',
  'Cash Banked Today (KES)': 'Pesa Iliyopelekwa Benki Leo (KES)', 'Balance in Till (auto)': 'Salio kwenye Droo (hujikokotoa)',
  'Credit / Card / Other': 'Mkopo / Kadi / Nyingine', 'Credit Sales (KES)': 'Mauzo ya Mkopo (KES)',
  'Card / POS Payments (KES)': 'Malipo ya Kadi / POS (KES)', 'Account / Customer Name': 'Akaunti / Jina la Mteja',
  'Cash': 'Pesa Taslimu', 'Credit+Card': 'Mkopo+Kadi', 'Total Collected': 'Jumla Iliyokusanywa',
  'Cash per Attendant': 'Pesa kwa Kila Mhudumu', 'Sales from their pumps vs. money handed in': 'Mauzo ya pampu zao dhidi ya pesa walizokabidhi',
  'Attendant': 'Mhudumu', 'Sales on Their Pumps (KES)': 'Mauzo ya Pampu Zao (KES)', 'Cash Handed In (KES)': 'Pesa Taslimu Iliyokabidhiwa (KES)',
  'M-Pesa to Till (KES)': 'M-Pesa kwenye Till (KES)', 'Add Attendant': 'Ongeza Mhudumu', 'Attendants': 'Wahudumu',
  'Total short': 'Jumla ya upungufu', 'Total over': 'Jumla ya ziada', 'Balanced': 'Inalingana',
  'No attendants added for this day.': 'Hakuna wahudumu walioongezwa kwa siku hii.',

  // ── Gases & lubricants ──
  'Gases & Lubricants — Itemised Sales': 'Gesi na Vilainishi — Mauzo kwa Bidhaa',
  'LPG cylinders, engine oil, grease, coolant, etc.': 'Mitungi ya gesi, mafuta ya injini, grisi, kipozaji, n.k.',
  'Product Name': 'Jina la Bidhaa', 'Category': 'Aina', 'Gas / LPG': 'Gesi / LPG', 'Lubricant / Oil': 'Kilainishi / Mafuta',
  'Other': 'Nyingine', 'Quantity': 'Idadi', 'Unit Price (KES)': 'Bei ya Kimoja (KES)', 'Add Item': 'Ongeza Bidhaa',
  'Items': 'Bidhaa', 'Gas Sales': 'Mauzo ya Gesi', 'Lubricant Sales': 'Mauzo ya Vilainishi', 'Total Revenue': 'Jumla ya Mapato',
  'This total is automatically added to Gross Revenue and Net Profit.': 'Jumla hii huongezwa yenyewe kwenye Mapato na Faida Halisi.',

  // ── Dips and deliveries ──
  'Tank Dip Reconciliation': 'Ulinganisho wa Vipimo vya Tanki', 'Physical stock check vs. pump meter sales': 'Ukaguzi wa akiba halisi dhidi ya mauzo ya mita',
  'Expected Stock = Opening Dip + Deliveries Received − Litres Sold (from pump meters)':
    'Akiba Inayotarajiwa = Kipimo cha Mwanzo + Mafuta Yaliyopokelewa − Lita Zilizouzwa (kutoka mita)',
  'Petrol Tank Dip': 'Kipimo cha Tanki la Petroli', 'Diesel Tank Dip': 'Kipimo cha Tanki la Dizeli',
  'Kerosene Tank Dip': 'Kipimo cha Tanki la Mafuta ya Taa', 'Opening Dip (L)': 'Kipimo cha Mwanzo (L)',
  'Deliveries Received (L)': 'Mafuta Yaliyopokelewa (L)', 'Closing Dip (L)': 'Kipimo cha Mwisho (L)',
  'Litres Sold (Pump)': 'Lita Zilizouzwa (Pampu)', 'Expected Stock': 'Akiba Inayotarajiwa', 'Within Tolerance': 'Ndani ya Kiwango',
  'Stock Short (possible leak/theft)': 'Akiba Pungufu (huenda ni uvujaji/wizi)', 'Stock Surplus': 'Akiba ya Ziada',
  'Fuel Deliveries': 'Mapokezi ya Mafuta', 'Received litres fill the Deliveries boxes above': 'Lita zilizopokelewa hujaza visanduku vya juu',
  'Fuel': 'Mafuta', 'Supplier': 'Msambazaji', 'Delivery Note No.': 'Namba ya Hati ya Mapokezi', 'Truck Reg.': 'Namba ya Lori',
  'Litres Ordered': 'Lita Zilizoagizwa', 'Litres Received': 'Lita Zilizopokelewa', 'Dip Before (L)': 'Kipimo Kabla (L)',
  'Dip After (L)': 'Kipimo Baada (L)', 'Add Delivery': 'Ongeza Mapokezi', 'No deliveries recorded today.': 'Hakuna mapokezi yaliyorekodiwa leo.',
  'Full': 'Kamili', 'optional': 'si lazima', 'HOW TO READ VARIANCE': 'JINSI YA KUSOMA TOFAUTI',

  // ── Expenses, receipts, invoices ──
  'Staff Wages (KES)': 'Mishahara ya Wafanyakazi (KES)', 'Electricity / Generator (KES)': 'Umeme / Jenereta (KES)',
  'Water (KES)': 'Maji (KES)', 'Maintenance / Equipment (KES)': 'Matengenezo / Vifaa (KES)',
  'Lubricants / Oil Stock (KES)': 'Vilainishi / Akiba ya Mafuta (KES)', 'Miscellaneous (KES)': 'Mengineyo (KES)',
  'Miscellaneous — Itemised': 'Mengineyo — kwa Kila Kitu', 'Click "＋ Add Item" for each thing you spent on':
    'Bonyeza "＋ Ongeza Kitu" kwa kila ulichotumia', 'Item Name': 'Jina la Kitu', 'Amount (KES)': 'Kiasi (KES)',
  'Miscellaneous Total': 'Jumla ya Mengineyo', 'Total Expenses': 'Jumla ya Matumizi', 'Revenue/L': 'Mapato/L',
  'Profit/L': 'Faida/L', 'Sales After Expenses': 'Mauzo Baada ya Matumizi',
  'No items yet — add each miscellaneous expense below.': 'Hakuna vitu bado — ongeza kila matumizi mengineyo hapa chini.',
  'Receipt Photos': 'Picha za Risiti', 'Receipts and delivery notes for this day': 'Risiti na hati za mapokezi za siku hii',
  'What is it for?': 'Ni ya nini?', 'Wages': 'Mishahara', 'Electricity / Generator': 'Umeme / Jenereta', 'Water': 'Maji',
  'Maintenance / Equipment': 'Matengenezo / Vifaa', 'Lubricants / Oil Stock': 'Vilainishi / Akiba ya Mafuta',
  'Miscellaneous': 'Mengineyo', 'Delivery note': 'Hati ya mapokezi', 'Amount (KES, optional)': 'Kiasi (KES, si lazima)',
  'Photo': 'Picha', 'Add Photo': 'Ongeza Picha', 'Uploading…': 'Inapakia…', 'No photos for this day yet.': 'Hakuna picha za siku hii bado.',
  'Credit Customers — Invoiced Fuel Sales': 'Wateja wa Mkopo — Mauzo ya Mafuta kwa Ankara', 'New Invoice Entry': 'Ankara Mpya',
  'Credit Account': 'Akaunti ya Mkopo', 'No account (one-off) —': 'Hakuna akaunti (mara moja) —',
  'Customer Name': 'Jina la Mteja', 'Company Name': 'Jina la Kampuni', 'Car Registration No.': 'Namba ya Usajili wa Gari',
  'Phone Number': 'Namba ya Simu', 'Fuel Type': 'Aina ya Mafuta', 'Add Invoice': 'Ongeza Ankara', 'Customer': 'Mteja',
  'Company': 'Kampuni', 'Car Reg No.': 'Namba ya Gari', 'Phone': 'Simu', 'Amount': 'Kiasi', 'Print': 'Chapisha', 'Del': 'Futa',
  'No invoices added yet — fill the form above.': 'Hakuna ankara bado — jaza fomu hapo juu.', 'Invoices Today': 'Ankara za Leo',
  'Total Invoiced': 'Jumla ya Ankara', 'Auto-added to Credit Sales in Payments tab': 'Huongezwa yenyewe kwenye Mauzo ya Mkopo (Malipo)',
  'Over the credit limit': 'Juu ya kikomo cha mkopo',

  // ── KRA page (official tax terms stay in English) ──
  'Taxpayer PIN': 'PIN ya Mlipakodi', 'Business Registered Name': 'Jina la Biashara Lililosajiliwa',
  'Tax Period (Month/Year)': 'Kipindi cha Kodi (Mwezi/Mwaka)', 'Station / Branch': 'Kituo / Tawi',
  'ETR / ESD Machine No.': 'Namba ya Mashine ya ETR / ESD', 'Return Type': 'Aina ya Ritani', 'Auto-Computed Tax Figures': 'Takwimu za Kodi (Hujikokotoa)',
  'Remarks / Adjustments / Exemptions / Credits': 'Maelezo / Marekebisho / Misamaha / Salio', 'Preview & File KRA Return': 'Hakiki na Wasilisha Ritani ya KRA',
  'Save Daily Record': 'Hifadhi Rekodi ya Siku', 'Approve Day': 'Idhinisha Siku', 'Print Report': 'Chapisha Ripoti',
  'Export CSV': 'Pakua CSV', 'Clear Form': 'Futa Fomu', 'Registered Business Name': 'Jina la Biashara Lililosajiliwa',
  'Enter any tax adjustments, credit notes, exemptions, or notes for this period…': 'Andika marekebisho ya kodi, hati za salio, misamaha au maelezo ya kipindi hiki…',

  // ── Prices page ──
  'Prices in force': 'Bei zinazotumika', 'Selling /L': 'Kuuza /L', 'Cost /L': 'Kununua /L', 'Since': 'Tangu', 'Set by': 'Imewekwa na',
  'Prices set here fill in automatically on the Fuel Entry page and can\'t be typed over. Fuels with no price set can still be typed in.':
    'Bei zinazowekwa hapa hujazwa zenyewe kwenye ukurasa wa Uingizaji wa Mafuta na haziwezi kubadilishwa. Mafuta yasiyo na bei iliyowekwa yanaweza kuandikwa.',
  'Set New Prices (admin)': 'Weka Bei Mpya (msimamizi)', 'Branches': 'Matawi', 'All branches': 'Matawi yote', 'All Branches': 'Matawi Yote',
  'Effective From': 'Kuanzia Tarehe', 'Petrol Selling /L': 'Petroli Kuuza /L', 'Petrol Cost /L': 'Petroli Kununua /L',
  'Diesel Selling /L': 'Dizeli Kuuza /L', 'Diesel Cost /L': 'Dizeli Kununua /L', 'Kerosene Selling /L': 'Mafuta ya Taa Kuuza /L',
  'Kerosene Cost /L': 'Mafuta ya Taa Kununua /L',
  'Leave a fuel blank to keep its current price. EPRA reviews prices on the 14th of each month, effective the 15th.':
    'Acha mafuta wazi ili kubaki na bei yake ya sasa. EPRA hupitia bei tarehe 14 kila mwezi, zikianza tarehe 15.',
  'Save Prices': 'Hifadhi Bei', 'Price History': 'Historia ya Bei', 'From': 'Kuanzia', 'Branch': 'Tawi', 'Selling': 'Kuuza', 'Cost': 'Kununua',
  'Not set — typed in on Fuel Entry': 'Haijawekwa — huandikwa kwenye Uingizaji wa Mafuta', 'No prices set yet.': 'Hakuna bei zilizowekwa bado.',

  // ── Credit accounts ──
  'Balance': 'Salio', 'Limit': 'Kikomo', 'New Credit Account': 'Akaunti Mpya ya Mkopo', 'Credit Limit (KES)': 'Kikomo cha Mkopo (KES)',
  'managers & admins set this': 'huwekwa na mameneja na wasimamizi', 'Add Account': 'Ongeza Akaunti', 'Over limit': 'Juu ya kikomo',
  'Statement': 'Taarifa ya Akaunti', 'Date': 'Tarehe', 'Details': 'Maelezo', 'Record a Payment': 'Rekodi Malipo', 'Method': 'Njia',
 'Bank transfer': 'Uhamisho wa benki', 'Cheque': 'Hundi', 'Reference': 'Kumbukumbu',
  'Record Payment': 'Rekodi Malipo', 'Credit Limit (Manager / Admin)': 'Kikomo cha Mkopo (Meneja / Msimamizi)',
  'Credit limit (KES, 0 = none)': 'Kikomo cha mkopo (KES, 0 = hakuna)', 'Save Account': 'Hifadhi Akaunti',
  'Print Statement': 'Chapisha Taarifa', 'No invoices or payments yet.': 'Hakuna ankara wala malipo bado.',
  'No credit accounts yet — add one below.': 'Hakuna akaunti za mkopo bado — ongeza moja hapa chini.',

  // ── Monthly report ──
  'Month': 'Mwezi', 'Print / PDF': 'Chapisha / PDF', 'Download for Excel': 'Pakua kwa Excel',
  'Branches Side by Side': 'Matawi Sambamba', 'Day by Day': 'Siku kwa Siku', 'Profit': 'Faida', 'Sales': 'Mauzo', 'Status': 'Hali',
  'Days Approved': 'Siku Zilizoidhinishwa', 'Days recorded': 'Siku zilizorekodiwa', 'Days approved': 'Siku zilizoidhinishwa',
  'Days flagged ⚠️': 'Siku zenye alama ⚠️', 'No records saved for this month.': 'Hakuna rekodi zilizohifadhiwa mwezi huu.',
  'No days recorded.': 'Hakuna siku zilizorekodiwa.', 'Petrol litres': 'Lita za petroli', 'Diesel litres': 'Lita za dizeli',
  'Kerosene litres': 'Lita za mafuta ya taa', 'Total litres': 'Jumla ya lita', 'Sales (KES)': 'Mauzo (KES)',
  'Fuel cost (KES)': 'Gharama ya mafuta (KES)', 'Expenses (KES)': 'Matumizi (KES)', 'Net profit (KES)': 'Faida halisi (KES)',
  'Tax total (KES)': 'Jumla ya kodi (KES)', 'M-Pesa (KES)': 'M-Pesa (KES)', 'Cash (KES)': 'Pesa taslimu (KES)',
  'Card (KES)': 'Kadi (KES)', 'Credit sales (KES)': 'Mauzo ya mkopo (KES)', 'Sales not collected (KES)': 'Mauzo yasiyokusanywa (KES)',
  'Attendant shortages (KES)': 'Upungufu wa wahudumu (KES)', 'Delivery shortfall (L)': 'Upungufu wa mapokezi (L)',
  'Dip variance (L)': 'Tofauti ya vipimo (L)',

  // ── Analytics and records ──
  'Revenue — Last 7 Days': 'Mapato — Siku 7 Zilizopita', 'Net Profit — Last 7 Days': 'Faida Halisi — Siku 7 Zilizopita',
  'Litres Sold — Last 7 Days': 'Lita Zilizouzwa — Siku 7 Zilizopita', 'All-Time Totals': 'Jumla Zote',
  'No data yet — save records to see charts.': 'Hakuna data bado — hifadhi rekodi ili kuona chati.',
  'No records yet — save a daily entry first.': 'Hakuna rekodi bado — hifadhi rekodi ya siku kwanza.',
  'Days Recorded': 'Siku Zilizorekodiwa', 'Total Litres Sold': 'Jumla ya Lita Zilizouzwa', 'Total Net Profit': 'Jumla ya Faida Halisi',
  'Avg Daily Profit': 'Wastani wa Faida kwa Siku', 'Total M-Pesa': 'Jumla ya M-Pesa', 'Total Cash': 'Jumla ya Pesa Taslimu',
  'Total KRA Tax': 'Jumla ya Kodi ya KRA', 'Refresh': 'Onyesha upya', 'Filter Branch': 'Chuja Tawi', 'Hide Filter': 'Ficha Kichujio',
  'Bin': 'Pipa la Taka', 'Move All to Bin': 'Hamishia Zote Pipani', 'Station': 'Tawi', 'Operator': 'Mhudumu',
  'P-Litres': 'Lita-P', 'D-Litres': 'Lita-D', 'Total L': 'Jumla L', 'Sales KES': 'Mauzo KES', 'Tax Total': 'Jumla ya Kodi',
  'Approved': 'Imeidhinishwa', 'Open': 'Wazi', 'Waiting to send': 'Inasubiri kutumwa',
  'Saved on this phone — will be sent when online': 'Imehifadhiwa kwenye simu hii — itatumwa ukiwa mtandaoni',

  // ── Record details ──
  'Fuel Sales': 'Mauzo ya Mafuta',
  'Pump Sales Meter Cross-Check': 'Ukaguzi wa Mita ya Mauzo', 'Branches (Admin)': 'Matawi (Msimamizi)', 'New branch name': 'Jina la tawi jipya',
  'Add Branch': 'Ongeza Tawi', 'Forgot password?': 'Umesahau nenosiri?', 'Forgot password': 'Umesahau nenosiri',
  'Enter your username. A 6-digit code is sent to your email or phone — or, if your account has neither, to the admin, who can give it to you.':
    'Andika jina lako la mtumiaji. Nambari ya tarakimu 6 itatumwa kwa barua pepe au simu yako — au, kama akaunti yako haina vyote viwili, kwa msimamizi, ambaye atakupa.',
  'Send Code': 'Tuma Nambari', '6-digit code': 'Nambari ya tarakimu 6', 'New password (8+ chars, not a common one)': 'Nenosiri jipya (herufi 8+, lisilo la kawaida)',
  'Set New Password': 'Weka Nenosiri Jipya', 'Send a new code': 'Tuma nambari mpya', '← Back to sign in': '← Rudi kuingia',
  'Your Email & Phone': 'Barua Pepe na Simu Yako', 'Used to send you a code if you forget your password.': 'Hutumika kukutumia nambari ukisahau nenosiri lako.',
  'Phone (for SMS)': 'Simu (kwa SMS)', 'Save Email & Phone': 'Hifadhi Barua Pepe na Simu', 'Email & phone saved': 'Barua pepe na simu zimehifadhiwa',
  'Email (optional)': 'Barua pepe (si lazima)', 'Phone (optional)': 'Simu (si lazima)',
  'Password changed — sign in with your new password.': 'Nenosiri limebadilishwa — ingia kwa nenosiri lako jipya.',
  'That code is wrong or has expired — ask for a new one': 'Nambari hiyo si sahihi au imeisha muda — omba mpya',
  'Check the phone number (e.g. 0712 345 678)': 'Kagua nambari ya simu (mfano 0712 345 678)', 'Check the email address': 'Kagua anwani ya barua pepe', 'Rename': 'Badilisha Jina', 'Branch name unchanged': 'Jina la tawi halijabadilika', 'Remove': 'Ondoa', 'Remove branch?': 'Ondoa tawi?', '— No branch yet —': '— Bado hakuna tawi —',
  'No branches yet — add the first one below.': 'Bado hakuna matawi — ongeza la kwanza hapa chini.',
  'No branches yet. Add your first branch under 👤 Account → Branches, then you can start recording.':
    'Bado hakuna matawi. Ongeza tawi lako la kwanza kwenye 👤 Akaunti → Matawi, kisha unaweza kuanza kurekodi.',
  'No branches have been set up yet. Ask the admin to add your branch.': 'Bado hakuna matawi yaliyowekwa. Mwombe msimamizi aongeze tawi lako.',
  'Choose a branch first — the admin adds branches under 👤 Account': 'Chagua tawi kwanza — msimamizi huongeza matawi kwenye 👤 Akaunti', 'Backups (Admin)': 'Nakala za Akiba (Msimamizi)',
  'Email the nightly backup to (comma-separated)': 'Tuma nakala ya kila usiku kwa barua pepe (tenganisha kwa koma)',
  'Back Up Now': 'Hifadhi Nakala Sasa', 'Email a Backup Now': 'Tuma Nakala kwa Barua Pepe Sasa', 'Download': 'Pakua',
  'Backup email saved': 'Barua pepe ya nakala imehifadhiwa',
  'No backup yet — the first one is made within a few minutes of the server starting.': 'Bado hakuna nakala — ya kwanza hufanywa dakika chache baada ya seva kuanza.',
  "Email isn't set up on the server, so backups are not emailed yet (see README: PK_SMTP_*).": 'Barua pepe haijawekwa kwenye seva, kwa hiyo nakala bado hazitumwi (tazama README: PK_SMTP_*).',
  "Add an email address below so a copy of each night's backup leaves the server.": 'Weka anwani ya barua pepe hapa chini ili nakala ya kila usiku itoke nje ya seva.',
  "Each night's backup is emailed to the addresses below.": 'Nakala ya kila usiku hutumwa kwa anwani zilizo hapa chini.', 'Pumps & Sales Meter Check': 'Pampu na Ukaguzi wa Mita ya Mauzo', 'Payments Collected': 'Malipo Yaliyokusanywa',
  'Credit': 'Mkopo', 'Card': 'Kadi', 'Credit Customer Invoices': 'Ankara za Wateja wa Mkopo', 'Electricity': 'Umeme',
  'Maintenance': 'Matengenezo', 'Lubricants Stock': 'Akiba ya Vilainishi', 'Profit & Loss': 'Faida na Hasara',
  'Gross Revenue': 'Mapato Ghafi', 'Total Cost': 'Jumla ya Gharama', 'Profit Margin': 'Kiwango cha Faida', 'KRA Tax': 'Kodi ya KRA',
  'Total Excise Duty': 'Jumla ya Ushuru wa Bidhaa', 'Total Tax Payable': 'Jumla ya Kodi Inayolipwa', 'KRA PIN': 'PIN ya KRA',
  'Day Approval': 'Idhini ya Siku', 'Opening Readings Check': 'Ukaguzi wa Usomaji wa Mwanzo', 'Deliveries': 'Mapokezi',
  'Change History': 'Historia ya Mabadiliko', 'Remarks': 'Maelezo', 'Close': 'Funga', 'Reopen Day': 'Fungua Siku Tena',
  'Move to Bin': 'Hamishia Pipani', 'Open — not yet approved': 'Wazi — bado haijaidhinishwa', 'Loading…': 'Inapakia…',
  'No history yet.': 'Hakuna historia bado.', 'Daily Record': 'Rekodi ya Siku',

  // ── Confirmations, bin, alerts ──
  'Are you sure?': 'Una uhakika?', 'Cancel': 'Ghairi', 'Yes, Proceed': 'Ndiyo, Endelea', 'Move to Bin?': 'Hamishia Pipani?',
  'This record will be moved to the bin. An admin can restore it.': 'Rekodi hii itahamishiwa pipani. Msimamizi anaweza kuirejesha.',
  'Approve and lock this day?': 'Idhinisha na ufunge siku hii?',
  'Once approved, nobody can change or delete this day until an admin reopens it.':
    'Ikishaidhinishwa, hakuna anayeweza kubadilisha au kufuta siku hii hadi msimamizi aifungue tena.',
  'Records moved to the bin. Restore one to put it back, or delete it for good. Every version stays in the change history either way.':
    'Rekodi zilizohamishiwa pipani. Rejesha moja kuirudisha, au ifute kabisa. Kila toleo hubaki kwenye historia ya mabadiliko.',
  'Restore': 'Rejesha', 'Delete for good': 'Futa kabisa', 'The bin is empty.': 'Pipa liko tupu.',
  'Alerts': 'Arifa', 'Raised automatically when a saved day shows a problem. They clear themselves when the day is corrected.':
    'Hutolewa zenyewe siku iliyohifadhiwa ikionyesha tatizo. Hufutika zenyewe siku ikirekebishwa.',
  'Mark all read': 'Weka zote kama zimesomwa', 'No open alerts. 👍': 'Hakuna arifa wazi. 👍', 'emailed': 'imetumwa kwa barua pepe',
  'Tank stock short': 'Akiba ya tanki pungufu', 'Low tank stock': 'Akiba ya tanki iko chini', 'Cash short': 'Pesa pungufu',
  'Attendant short': 'Mhudumu ana upungufu', 'Opening readings changed': 'Usomaji wa mwanzo umebadilishwa', 'Short delivery': 'Mapokezi pungufu',

  // ── Account ──
  'Your Name': 'Jina Lako', 'Full name (shown as Operator)': 'Jina kamili (huonyeshwa kama Mhudumu)', 'Save Name': 'Hifadhi Jina',
  'Change Password': 'Badilisha Nenosiri', 'Current Password': 'Nenosiri la Sasa', 'New Password (8+ chars, not a common one)':
    'Nenosiri Jipya (herufi 8+, lisilo la kawaida)', 'Update Password': 'Sasisha Nenosiri', 'Users (Admin)': 'Watumiaji (Msimamizi)',
  'Full Name': 'Jina Kamili', 'Password (8+ chars, not a common one)': 'Nenosiri (herufi 8+, lisilo la kawaida)', 'Role': 'Wadhifa',
  'Staff': 'Mfanyakazi', 'Branch Manager': 'Meneja wa Tawi', 'Admin': 'Msimamizi', 'Branch (required for managers)': 'Tawi (lazima kwa mameneja)',
  'Add User': 'Ongeza Mtumiaji', 'Alert Settings (Admin)': 'Mipangilio ya Arifa (Msimamizi)',
  'Email alerts to (comma-separated)': 'Tuma arifa kwa barua pepe hizi (tenganisha kwa koma)',
  'Tank short by more than (L)': 'Tanki pungufu kwa zaidi ya (L)', 'Cash short by more than (KES)': 'Pesa pungufu kwa zaidi ya (KES)',
  'Attendant short by more than (KES)': 'Mhudumu pungufu kwa zaidi ya (KES)', 'Delivery short by more than (L)': 'Mapokezi pungufu kwa zaidi ya (L)',
  'Low petrol below (L)': 'Petroli chini ya (L)', 'Low diesel below (L)': 'Dizeli chini ya (L)', 'Low kerosene below (L)': 'Mafuta ya taa chini ya (L)',
  'Save Alert Settings': 'Hifadhi Mipangilio ya Arifa', 'Send Test Email': 'Tuma Barua Pepe ya Majaribio',
  'Sign out other devices': 'Toka kwenye vifaa vingine', 'Administrator — all branches': 'Msimamizi — matawi yote',
  'Reset password': 'Weka nenosiri jipya', 'Sign out on every device': 'Toka kwenye kila kifaa',

  // ── Messages ──
  '📴 Saved on this phone — it will be sent when you are back online': '📴 Imehifadhiwa kwenye simu hii — itatumwa ukirudi mtandaoni',
  '⚠️ No data to save — fill in fuel readings first': '⚠️ Hakuna data ya kuhifadhi — jaza usomaji wa mafuta kwanza',
  '✅ Day approved and locked': '✅ Siku imeidhinishwa na kufungwa', '🔓 Day reopened': '🔓 Siku imefunguliwa tena',
  '🗑️ Moved to the bin': '🗑️ Imehamishiwa pipani', '↩ Record restored': '↩ Rekodi imerejeshwa', '🔑 Password changed': '🔑 Nenosiri limebadilishwa',
  '🚚 Delivery added': '🚚 Mapokezi yameongezwa', '💵 Payment recorded': '💵 Malipo yamerekodiwa', '✅ Alert settings saved': '✅ Mipangilio ya arifa imehifadhiwa',
  '📷 Photo added — click 💾 Save to keep it with this day': '📷 Picha imeongezwa — bonyeza 💾 Hifadhi ili ibaki na siku hii',
  '⚠️ Choose or take a photo first': '⚠️ Chagua au piga picha kwanza', 'Save the day first, then approve it': 'Hifadhi siku kwanza, kisha uiidhinishe',
  "This date is in the future, so it can't be saved yet.": 'Tarehe hii ni ya baadaye, kwa hiyo haiwezi kuhifadhiwa bado.',
  "🔒 This day is locked. Staff can change today's and yesterday's records only — ask an admin to change it.":
    '🔒 Siku hii imefungwa. Wafanyakazi wanaweza kubadilisha rekodi za leo na jana tu — mwombe msimamizi aibadilishe.',
  'Records older than yesterday are locked — ask a manager or admin to change them':
    'Rekodi za kabla ya jana zimefungwa — mwombe meneja au msimamizi azibadilishe',
  'This day is approved and locked — an admin must reopen it first': 'Siku hii imeidhinishwa na kufungwa — msimamizi lazima aifungue kwanza',
  "You can't save a record for a future date": 'Huwezi kuhifadhi rekodi ya tarehe ya baadaye',
  'That password is too easy to guess — choose another': 'Nenosiri hilo ni rahisi kukisia — chagua jingine',
  'Password must be at least 8 characters': 'Nenosiri lazima liwe na angalau herufi 8',
  'No connection to the server': 'Hakuna muunganisho na seva',
};

// Text built from changing values: [pattern, Kiswahili replacement]
const SW_PATTERNS = [
  [/^✅ Record saved — (.+)$/, '✅ Rekodi imehifadhiwa — $1'],
  [/^✅ Record updated — (.+)$/, '✅ Rekodi imesasishwa — $1'],
  [/^📂 Loaded existing record for (.+)$/, '📂 Rekodi iliyopo imefunguliwa: $1'],
  [/^🆕 No record for (.+) — ready for new entry$/, '🆕 Hakuna rekodi ya $1 — tayari kwa ingizo jipya'],
  [/^👋 Welcome, (.+)$/, '👋 Karibu, $1'],
  [/^⚠️ Save failed: (.+)$/, '⚠️ Imeshindwa kuhifadhi: $1'],
  [/^📤 Sent (\d+) days? saved while offline$/, '📤 Siku $1 zilizohifadhiwa nje ya mtandao zimetumwa'],
  [/^Online · (\d+) waiting to send$/, 'Mtandaoni · $1 zinasubiri kutumwa'],
  [/^Offline · (\d+) waiting to send$/, 'Nje ya mtandao · $1 zinasubiri kutumwa'],
  [/^Margin: (.+)$/, 'Kiwango cha faida: $1'],
  [/^Branch added — (.+)$/, 'Tawi limeongezwa — $1'],
  [/^Branch removed — (.+)$/, 'Tawi limeondolewa — $1'],
  [/^If that username exists, a 6-digit code has been sent to its email or phone — or, if it has neither, to the admin\. The code works for (\d+) minutes\.(.*)$/,
    'Kama jina hilo lipo, nambari ya tarakimu 6 imetumwa kwa barua pepe au simu yake — au, kama haina vyote viwili, kwa msimamizi. Nambari inafanya kazi kwa dakika $1.$2'],
  [/^Branch renamed — (.+) → (.+)$/, 'Jina la tawi limebadilishwa — $1 → $2'],
  [/^Last backup: (.+)\. A new one is made every night; the latest 14 are kept on the server\.$/, 'Nakala ya mwisho: $1. Mpya hufanywa kila usiku; 14 za mwisho huhifadhiwa kwenye seva.'],
  [/^Last emailed (.+) to (.+)\.$/, 'Ilitumwa mara ya mwisho $1 kwa $2.'],
  [/^The last backup email failed: (.+)$/, 'Barua pepe ya nakala ya mwisho ilishindwa: $1'],
  [/^Backup made — (.+)$/, 'Nakala imefanywa — $1'],
  [/^Backup emailed to (.+)$/, 'Nakala imetumwa kwa $1'],
  [/^Pump ([PDK]\d)$/, 'Pampu $1'],
  [/^Pump ([PDK]\d) · (Petrol|Diesel|Kerosene)$/, (m, id, f) => 'Pampu ' + id + ' · ' + ({ Petrol: 'Petroli', Diesel: 'Dizeli', Kerosene: 'Mafuta ya Taa' })[f]],
  [/^([\d.,]+) L sold$/, 'Lita $1 zimeuzwa'],
  [/^Pump ([PDK]\d) (opening|closing) (sales )?meter$/, (m, id, oc, sales) =>
    'Pampu ' + id + ': mita ya ' + (sales ? 'mauzo ' : '') + (oc === 'opening' ? 'ya kufungua' : 'ya kufunga')],
  [/^Profit\/L: (.+)$/, 'Faida/L: $1'],
  [/^(\d+) records? — all branches$/, 'Rekodi $1 — matawi yote'],
  [/^Short KES (.+)$/, 'Upungufu KES $1'], [/^Over KES (.+)$/, 'Ziada KES $1'],
  [/^Created by (.+)$/, 'Imeundwa na $1'], [/^Changed by (.+)$/, 'Imebadilishwa na $1'],
  [/^Moved to bin by (.+)$/, 'Imehamishiwa pipani na $1'], [/^Restored from bin by (.+)$/, 'Imerejeshwa na $1'],
  [/^Approved and locked by (.+)$/, 'Imeidhinishwa na kufungwa na $1'], [/^Reopened by (.+)$/, 'Imefunguliwa tena na $1'],
  [/^✅ Approved by (.+)$/, '✅ Imeidhinishwa na $1'],
  [/^✅ This day was approved by (.+) and is locked\. An admin must reopen it to make changes\.$/,
    '✅ Siku hii iliidhinishwa na $1 na imefungwa. Msimamizi lazima aifungue tena ili kufanya mabadiliko.'],
  [/^Branch Manager — (.+)$/, 'Meneja wa Tawi — $1'], [/^Staff — (.+)$/, 'Mfanyakazi — $1'],
  [/^↪ Opening readings filled from (.+)'s closing readings\.$/, '↪ Usomaji wa mwanzo umejazwa kutoka usomaji wa mwisho wa $1.'],
  [/^e\.g\. (.+)$/, 'mf. $1'],
  [/^(.+)% of sales · (\d+) txns$/, '$1% ya mauzo · miamala $2'],
  [/^P: (.+)L \| D: (.+)L \| K: (.+)L$/, 'P: $1L | D: $2L | MT: $3L'],
  [/^Petrol (.+)L · Diesel (.+)L · Kero (.+)L$/, 'Petroli $1L · Dizeli $2L · Mafuta ya taa $3L'],
  [/^Wages\+Util\+Misc: (.+)$/, 'Mishahara+Huduma+Mengineyo: $1'],
  [/^VAT: (.+) \| Excise: (.+)$/, 'VAT: $1 | Ushuru: $2'],
  [/^Fuel: (.+) \+ Gas\/Lube: (.+)$/, 'Mafuta: $1 + Gesi/Vilainishi: $2'],
  [/^(\d+) accounts? · KES (.+) owed$/, 'Akaunti $1 · KES $2 zinadaiwa'],
  [/^Balance KES (.+) of KES (.+) limit$/, 'Salio KES $1 kati ya kikomo cha KES $2'],
  [/^Balance KES (.+) · no limit set$/, 'Salio KES $1 · hakuna kikomo'],
];

function swCore(s) {
  if (Object.prototype.hasOwnProperty.call(SW, s)) return SW[s];
  for (const [re, rep] of SW_PATTERNS) if (re.test(s)) return s.replace(re, rep);
  return null;
}

// Translate one string; keeps leading emoji/symbols and a trailing colon
function t(s) {
  if (LANG !== 'sw' || !s) return s;
  const text = s.trim();
  if (!text) return s;
  let out = swCore(text.replace(/\s+/g, ' '));
  if (out === null) {
    const m = text.match(/^([^\p{L}\p{N}(]*)(.*?)(\s*:)?$/su);
    if (m && m[2]) {
      const core = swCore(m[2].replace(/\s+/g, ' '));
      if (core !== null) out = m[1] + core + (m[3] || '');
    }
  }
  return out === null ? s : s.replace(text, out);
}

const I18N_ATTRS = ['placeholder', 'title', 'aria-label'];

function translateTree(root) {
  if (LANG !== 'sw' || !root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    const p = root.parentElement;
    if (p && !['SCRIPT', 'STYLE', 'TEXTAREA'].includes(p.nodeName) && !p.closest('[translate="no"]')) {
      const v = t(root.nodeValue);
      if (v !== root.nodeValue) root.nodeValue = v;
    }
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  if (['SCRIPT', 'STYLE', 'TEXTAREA'].includes(root.nodeName) || root.closest('[translate="no"]')) return;
  [root, ...root.querySelectorAll('[placeholder],[title],[aria-label]')].forEach(el => {
    I18N_ATTRS.forEach(a => {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) { const tv = t(v); if (tv !== v) el.setAttribute(a, tv); }
    });
  });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(translateTree);
}

if (LANG === 'sw') {
  const start = () => {
    document.title = 'PetroKenya — Dashibodi ya Kituo';
    const note = document.getElementById('varianceNote');
    if (note) note.innerHTML = '⚠️ <b>JINSI YA KUSOMA TOFAUTI:</b> Tofauti <b>hasi</b> ina maana tanki lina ' +
      '<b>mafuta pungufu kuliko yanayotarajiwa</b> (huenda ni uvujaji, wizi au mita inasoma chini — chunguza). ' +
      'Tofauti <b>chanya</b> ina maana kuna <b>mafuta zaidi ya yanayotarajiwa</b> (huenda mita inasoma juu au kipimo ' +
      'si sahihi). Tofauti ndogo (chini ya ±10L) ni ya kawaida kutokana na uvukizi na upimaji.';
    translateTree(document.body);
    // Text the app adds or changes later is translated as it appears
    new MutationObserver(muts => muts.forEach(m => {
      if (m.type === 'characterData') translateTree(m.target);
      else if (m.type === 'attributes') translateTree(m.target);
      else m.addedNodes.forEach(translateTree);
    })).observe(document.body, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: I18N_ATTRS });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
