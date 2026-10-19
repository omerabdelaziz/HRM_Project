/**
 * ISO 3166-1 alpha-2 country codes with nationality (demonym) names in English and Arabic.
 * Country names are rendered with Intl.DisplayNames; nationalities need this table because Intl
 * has no demonyms. Codes without a demonym fall back to the country name.
 */

export const COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ',
  'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR',
  'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
  'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ',
  'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF',
  'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI',
  'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR',
  'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'XK', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const;

export type CountryCode = (typeof COUNTRY_CODES)[number];

const CODE_SET = new Set<string>(COUNTRY_CODES);
export const isCountryCode = (v: string | null | undefined): v is CountryCode => !!v && CODE_SET.has(v.toUpperCase());

/** [English, Arabic] nationality names. */
const DEMONYMS: Record<string, [string, string]> = {
  AE: ['Emirati', 'إماراتي'], SA: ['Saudi', 'سعودي'], KW: ['Kuwaiti', 'كويتي'], QA: ['Qatari', 'قطري'], BH: ['Bahraini', 'بحريني'], OM: ['Omani', 'عُماني'],
  YE: ['Yemeni', 'يمني'], IQ: ['Iraqi', 'عراقي'], JO: ['Jordanian', 'أردني'], SY: ['Syrian', 'سوري'], LB: ['Lebanese', 'لبناني'], PS: ['Palestinian', 'فلسطيني'],
  EG: ['Egyptian', 'مصري'], SD: ['Sudanese', 'سوداني'], SS: ['South Sudanese', 'جنوب سوداني'], LY: ['Libyan', 'ليبي'], TN: ['Tunisian', 'تونسي'], DZ: ['Algerian', 'جزائري'],
  MA: ['Moroccan', 'مغربي'], MR: ['Mauritanian', 'موريتاني'], SO: ['Somali', 'صومالي'], DJ: ['Djiboutian', 'جيبوتي'], KM: ['Comorian', 'قمري'],
  IN: ['Indian', 'هندي'], PK: ['Pakistani', 'باكستاني'], BD: ['Bangladeshi', 'بنغلاديشي'], LK: ['Sri Lankan', 'سريلانكي'], NP: ['Nepali', 'نيبالي'], AF: ['Afghan', 'أفغاني'],
  BT: ['Bhutanese', 'بوتاني'], MV: ['Maldivian', 'مالديفي'], PH: ['Filipino', 'فلبيني'], ID: ['Indonesian', 'إندونيسي'], MY: ['Malaysian', 'ماليزي'], TH: ['Thai', 'تايلندي'],
  VN: ['Vietnamese', 'فيتنامي'], MM: ['Myanmar', 'ميانماري'], KH: ['Cambodian', 'كمبودي'], LA: ['Lao', 'لاوسي'], SG: ['Singaporean', 'سنغافوري'], BN: ['Bruneian', 'بروناي'],
  CN: ['Chinese', 'صيني'], HK: ['Hong Konger', 'من هونغ كونغ'], TW: ['Taiwanese', 'تايواني'], JP: ['Japanese', 'ياباني'], KR: ['South Korean', 'كوري جنوبي'], KP: ['North Korean', 'كوري شمالي'],
  MN: ['Mongolian', 'منغولي'], IR: ['Iranian', 'إيراني'], TR: ['Turkish', 'تركي'], IL: ['Israeli', 'إسرائيلي'], CY: ['Cypriot', 'قبرصي'], AZ: ['Azerbaijani', 'أذربيجاني'],
  AM: ['Armenian', 'أرميني'], GE: ['Georgian', 'جورجي'], KZ: ['Kazakh', 'كازاخستاني'], UZ: ['Uzbek', 'أوزبكي'], TM: ['Turkmen', 'تركماني'], KG: ['Kyrgyz', 'قيرغيزي'], TJ: ['Tajik', 'طاجيكي'],
  RU: ['Russian', 'روسي'], UA: ['Ukrainian', 'أوكراني'], BY: ['Belarusian', 'بيلاروسي'], MD: ['Moldovan', 'مولدوفي'], PL: ['Polish', 'بولندي'], CZ: ['Czech', 'تشيكي'],
  SK: ['Slovak', 'سلوفاكي'], HU: ['Hungarian', 'مجري'], RO: ['Romanian', 'روماني'], BG: ['Bulgarian', 'بلغاري'], RS: ['Serbian', 'صربي'], HR: ['Croatian', 'كرواتي'],
  BA: ['Bosnian', 'بوسني'], SI: ['Slovenian', 'سلوفيني'], ME: ['Montenegrin', 'جبل أسودي'], MK: ['Macedonian', 'مقدوني'], AL: ['Albanian', 'ألباني'], XK: ['Kosovar', 'كوسوفي'],
  GR: ['Greek', 'يوناني'], IT: ['Italian', 'إيطالي'], ES: ['Spanish', 'إسباني'], PT: ['Portuguese', 'برتغالي'], FR: ['French', 'فرنسي'], DE: ['German', 'ألماني'],
  AT: ['Austrian', 'نمساوي'], CH: ['Swiss', 'سويسري'], BE: ['Belgian', 'بلجيكي'], NL: ['Dutch', 'هولندي'], LU: ['Luxembourgish', 'لوكسمبورغي'], IE: ['Irish', 'أيرلندي'],
  GB: ['British', 'بريطاني'], DK: ['Danish', 'دنماركي'], SE: ['Swedish', 'سويدي'], NO: ['Norwegian', 'نرويجي'], FI: ['Finnish', 'فنلندي'], IS: ['Icelandic', 'آيسلندي'],
  EE: ['Estonian', 'إستوني'], LV: ['Latvian', 'لاتفي'], LT: ['Lithuanian', 'ليتواني'], MT: ['Maltese', 'مالطي'], MC: ['Monegasque', 'موناكي'],
  US: ['American', 'أمريكي'], CA: ['Canadian', 'كندي'], MX: ['Mexican', 'مكسيكي'], BR: ['Brazilian', 'برازيلي'], AR: ['Argentine', 'أرجنتيني'], CL: ['Chilean', 'تشيلي'],
  CO: ['Colombian', 'كولومبي'], PE: ['Peruvian', 'بيروفي'], VE: ['Venezuelan', 'فنزويلي'], EC: ['Ecuadorian', 'إكوادوري'], BO: ['Bolivian', 'بوليفي'], UY: ['Uruguayan', 'أوروغوايي'],
  PY: ['Paraguayan', 'باراغواياني'], CU: ['Cuban', 'كوبي'], DO: ['Dominican', 'دومينيكاني'], JM: ['Jamaican', 'جامايكي'], TT: ['Trinidadian', 'ترينيدادي'], CR: ['Costa Rican', 'كوستاريكي'],
  PA: ['Panamanian', 'بنمي'], GT: ['Guatemalan', 'غواتيمالي'], HN: ['Honduran', 'هندوراسي'], SV: ['Salvadoran', 'سلفادوري'], NI: ['Nicaraguan', 'نيكاراغوي'], HT: ['Haitian', 'هايتي'],
  AU: ['Australian', 'أسترالي'], NZ: ['New Zealander', 'نيوزيلندي'], FJ: ['Fijian', 'فيجي'], PG: ['Papua New Guinean', 'من بابوا غينيا الجديدة'],
  NG: ['Nigerian', 'نيجيري'], GH: ['Ghanaian', 'غاني'], KE: ['Kenyan', 'كيني'], ET: ['Ethiopian', 'إثيوبي'], ER: ['Eritrean', 'إريتري'], UG: ['Ugandan', 'أوغندي'],
  TZ: ['Tanzanian', 'تنزاني'], RW: ['Rwandan', 'رواندي'], BI: ['Burundian', 'بوروندي'], ZA: ['South African', 'جنوب أفريقي'], ZW: ['Zimbabwean', 'زيمبابوي'], ZM: ['Zambian', 'زامبي'],
  MW: ['Malawian', 'ملاوي'], MZ: ['Mozambican', 'موزمبيقي'], AO: ['Angolan', 'أنغولي'], NA: ['Namibian', 'ناميبي'], BW: ['Botswanan', 'بوتسواني'], MG: ['Malagasy', 'مدغشقري'],
  MU: ['Mauritian', 'موريشيوسي'], SC: ['Seychellois', 'سيشيلي'], CM: ['Cameroonian', 'كاميروني'], CI: ['Ivorian', 'إيفواري'], SN: ['Senegalese', 'سنغالي'], ML: ['Malian', 'مالي'],
  NE: ['Nigerien', 'نيجري'], BF: ['Burkinabe', 'بوركيني'], GN: ['Guinean', 'غيني'], SL: ['Sierra Leonean', 'سيراليوني'], LR: ['Liberian', 'ليبيري'], TG: ['Togolese', 'توغولي'],
  BJ: ['Beninese', 'بنيني'], TD: ['Chadian', 'تشادي'], CF: ['Central African', 'من أفريقيا الوسطى'], CD: ['Congolese (DRC)', 'كونغولي (الكونغو الديمقراطية)'], CG: ['Congolese', 'كونغولي'],
  GA: ['Gabonese', 'غابوني'], GM: ['Gambian', 'غامبي'], CV: ['Cape Verdean', 'من الرأس الأخضر'], GQ: ['Equatorial Guinean', 'من غينيا الاستوائية'], LS: ['Basotho', 'ليسوتي'],
  SZ: ['Swazi', 'إسواتيني'], GW: ['Bissau-Guinean', 'من غينيا بيساو'], ST: ['Santomean', 'من ساو تومي'],
};

export function nationalityName(code: string | null | undefined, locale: 'en' | 'ar' = 'en'): string {
  if (!code) return '';
  const c = code.toUpperCase();
  const demonym = DEMONYMS[c];
  if (demonym) return demonym[locale === 'ar' ? 1 : 0];
  return countryName(c, locale);
}

export function countryName(code: string | null | undefined, locale: 'en' | 'ar' = 'en'): string {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
