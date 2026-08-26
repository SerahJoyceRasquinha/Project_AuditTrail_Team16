/**
 * City reference data, keyed by `COUNTRY-SUBDIVISION` (or bare `COUNTRY` for
 * countries with no subdivisions).
 *
 * Why cities are handled differently from countries and states
 * -----------------------------------------------------------
 * Countries and subdivisions have an international registry - ISO 3166 - so
 * they can be stored as codes and validated exactly. Cities have no such
 * registry. There is no authoritative, stable, machine-readable list of "every
 * place a container might be collected from", and any list this file could hold
 * would be a curated subset of somebody's opinion.
 *
 * That has two consequences, and both are deliberate:
 *
 * 1. **The city is stored as a plain string**, not a code. That is unchanged
 *    from before this list existed - the dropdown improves how the value is
 *    *entered*, it does not change what the ledger records.
 *
 * 2. **The backend does not reject a city that is absent from this list.** The
 *    country/state pairing is a closed set and is enforced strictly; the city
 *    is an open set and is only length-checked. Refusing an unlisted port would
 *    block a legitimate shipment because a data file was incomplete, which is a
 *    far worse failure than an inconsistent spelling. The UI therefore offers
 *    the list *and* an explicit "Other" escape hatch.
 *
 * The list below leans towards ports, freight hubs and administrative capitals,
 * because that is what a logistics operator actually ships between. It is not
 * exhaustive and is not meant to be; adding a city is one line here and is
 * picked up by the dropdown and the API together.
 */

const CITIES = {
  // --- United Arab Emirates -------------------------------------------------
  'AE-AZ': ['Abu Dhabi', 'Al Ain', 'Ruwais', 'Khalifa Port'],
  'AE-DU': ['Dubai', 'Jebel Ali', 'Deira', 'Port Rashid'],
  'AE-SH': ['Sharjah', 'Khor Fakkan', 'Kalba'],
  'AE-AJ': ['Ajman'],
  'AE-FU': ['Fujairah', 'Dibba Al-Fujairah'],
  'AE-RK': ['Ras Al Khaimah', 'Saqr Port'],
  'AE-UQ': ['Umm Al Quwain'],

  // --- Argentina ------------------------------------------------------------
  'AR-B': ['La Plata', 'Bahía Blanca', 'Mar del Plata', 'Campana'],
  'AR-C': ['Buenos Aires'],
  'AR-S': ['Rosario', 'Santa Fe', 'Villa Constitución'],
  'AR-X': ['Córdoba', 'Río Cuarto', 'Villa María'],
  'AR-M': ['Mendoza', 'San Rafael'],
  'AR-E': ['Paraná', 'Concordia', 'Gualeguaychú'],

  // --- Australia ------------------------------------------------------------
  'AU-NSW': ['Sydney', 'Newcastle', 'Port Botany', 'Wollongong'],
  'AU-VIC': ['Melbourne', 'Geelong', 'Portland'],
  'AU-QLD': ['Brisbane', 'Townsville', 'Gladstone', 'Cairns'],
  'AU-WA': ['Perth', 'Fremantle', 'Port Hedland', 'Dampier'],
  'AU-SA': ['Adelaide', 'Port Adelaide', 'Whyalla'],
  'AU-TAS': ['Hobart', 'Devonport', 'Burnie'],
  'AU-NT': ['Darwin', 'Alice Springs'],
  'AU-ACT': ['Canberra'],

  // --- Belgium --------------------------------------------------------------
  'BE-VAN': ['Antwerp', 'Mechelen'],
  'BE-VOV': ['Ghent', 'Aalst'],
  'BE-VWV': ['Zeebrugge', 'Bruges', 'Ostend'],
  'BE-VBR': ['Leuven', 'Vilvoorde'],
  'BE-VLI': ['Hasselt', 'Genk'],
  'BE-WHT': ['Charleroi', 'Mons'],
  'BE-WLG': ['Liège', 'Verviers'],
  'BE-BRU': ['Brussels'],

  // --- Brazil ---------------------------------------------------------------
  'BR-SP': ['Santos', 'São Paulo', 'Campinas', 'São Sebastião'],
  'BR-RJ': ['Rio de Janeiro', 'Itaguaí', 'Niterói'],
  'BR-SC': ['Itajaí', 'Navegantes', 'Florianópolis', 'São Francisco do Sul'],
  'BR-PR': ['Paranaguá', 'Curitiba', 'Antonina'],
  'BR-RS': ['Rio Grande', 'Porto Alegre', 'Pelotas'],
  'BR-BA': ['Salvador', 'Aratu', 'Ilhéus'],
  'BR-PE': ['Recife', 'Suape', 'Ipojuca'],
  'BR-CE': ['Fortaleza', 'Pecém'],
  'BR-PA': ['Belém', 'Barcarena', 'Santarém'],
  'BR-AM': ['Manaus', 'Itacoatiara'],
  'BR-ES': ['Vitória', 'Vila Velha', 'Tubarão'],
  'BR-MG': ['Belo Horizonte', 'Uberlândia'],
  'BR-GO': ['Goiânia', 'Anápolis'],

  // --- Canada ---------------------------------------------------------------
  'CA-BC': ['Vancouver', 'Prince Rupert', 'Victoria', 'Surrey'],
  'CA-ON': ['Toronto', 'Hamilton', 'Windsor', 'Thunder Bay', 'Ottawa'],
  'CA-QC': ['Montreal', 'Quebec City', 'Trois-Rivières', 'Sept-Îles'],
  'CA-AB': ['Calgary', 'Edmonton', 'Fort McMurray'],
  'CA-NS': ['Halifax', 'Sydney'],
  'CA-NB': ['Saint John', 'Moncton', 'Belledune'],
  'CA-MB': ['Winnipeg', 'Churchill'],
  'CA-SK': ['Saskatoon', 'Regina'],
  'CA-NL': ["St. John's", 'Corner Brook'],
  'CA-PE': ['Charlottetown', 'Summerside'],
  'CA-YT': ['Whitehorse'],
  'CA-NT': ['Yellowknife', 'Hay River'],
  'CA-NU': ['Iqaluit'],

  // --- China ----------------------------------------------------------------
  'CN-SH': ['Shanghai', 'Yangshan'],
  'CN-GD': ['Shenzhen', 'Guangzhou', 'Yantian', 'Zhuhai', 'Dongguan'],
  'CN-ZJ': ['Ningbo', 'Zhoushan', 'Hangzhou', 'Wenzhou'],
  'CN-SD': ['Qingdao', 'Yantai', 'Rizhao', 'Jinan'],
  'CN-TJ': ['Tianjin', 'Binhai'],
  'CN-FJ': ['Xiamen', 'Fuzhou', 'Quanzhou'],
  'CN-LN': ['Dalian', 'Yingkou', 'Shenyang'],
  'CN-JS': ['Suzhou', 'Nanjing', 'Lianyungang', 'Nantong'],
  'CN-HE': ['Qinhuangdao', 'Tangshan', 'Shijiazhuang'],
  'CN-BJ': ['Beijing'],
  'CN-CQ': ['Chongqing'],
  'CN-HB': ['Wuhan', 'Yichang'],
  'CN-HI': ['Haikou', 'Yangpu', 'Sanya'],
  'CN-AH': ['Hefei', 'Wuhu'],

  // --- Germany --------------------------------------------------------------
  'DE-HH': ['Hamburg'],
  'DE-HB': ['Bremen', 'Bremerhaven'],
  'DE-NI': ['Wilhelmshaven', 'Hanover', 'Emden', 'Cuxhaven'],
  'DE-SH': ['Kiel', 'Lübeck', 'Brunsbüttel'],
  'DE-NW': ['Duisburg', 'Cologne', 'Düsseldorf', 'Dortmund'],
  'DE-BY': ['Munich', 'Nuremberg', 'Augsburg'],
  'DE-BW': ['Stuttgart', 'Mannheim', 'Karlsruhe'],
  'DE-HE': ['Frankfurt', 'Wiesbaden', 'Kassel'],
  'DE-BE': ['Berlin'],
  'DE-BB': ['Potsdam', 'Cottbus'],
  'DE-MV': ['Rostock', 'Wismar', 'Sassnitz'],
  'DE-SN': ['Leipzig', 'Dresden', 'Chemnitz'],
  'DE-ST': ['Magdeburg', 'Halle'],
  'DE-TH': ['Erfurt', 'Jena'],
  'DE-RP': ['Mainz', 'Ludwigshafen', 'Koblenz'],
  'DE-SL': ['Saarbrücken'],

  // --- Denmark --------------------------------------------------------------
  'DK-84': ['Copenhagen', 'Helsingør'],
  'DK-82': ['Aarhus', 'Randers'],
  'DK-81': ['Aalborg', 'Frederikshavn', 'Hirtshals'],
  'DK-85': ['Køge', 'Kalundborg', 'Roskilde'],
  'DK-83': ['Odense', 'Esbjerg', 'Fredericia', 'Kolding'],

  // --- Egypt ----------------------------------------------------------------
  'EG-ALX': ['Alexandria', 'El Dekheila'],
  'EG-C': ['Cairo'],
  'EG-PTS': ['Port Said', 'East Port Said'],
  'EG-SUZ': ['Suez', 'Ain Sokhna'],
  'EG-IS': ['Ismailia'],
  'EG-DT': ['Damietta'],

  // --- Spain ----------------------------------------------------------------
  'ES-CT': ['Barcelona', 'Tarragona', 'Girona'],
  'ES-VC': ['Valencia', 'Alicante', 'Castellón', 'Sagunto'],
  'ES-AN': ['Algeciras', 'Málaga', 'Seville', 'Cádiz', 'Huelva'],
  'ES-MD': ['Madrid'],
  'ES-PV': ['Bilbao', 'Pasajes', 'San Sebastián'],
  'ES-GA': ['Vigo', 'A Coruña', 'Ferrol'],
  'ES-MC': ['Cartagena', 'Murcia'],
  'ES-AS': ['Gijón', 'Avilés'],
  'ES-CN': ['Las Palmas', 'Santa Cruz de Tenerife'],
  'ES-AR': ['Zaragoza'],

  // --- France ---------------------------------------------------------------
  'FR-PAC': ['Marseille', 'Fos-sur-Mer', 'Toulon', 'Nice'],
  'FR-NOR': ['Le Havre', 'Rouen', 'Caen', 'Cherbourg'],
  'FR-HDF': ['Dunkirk', 'Calais', 'Lille', 'Boulogne-sur-Mer'],
  'FR-IDF': ['Paris', 'Gennevilliers'],
  'FR-NAQ': ['Bordeaux', 'La Rochelle', 'Bayonne'],
  'FR-PDL': ['Nantes', 'Saint-Nazaire'],
  'FR-BRE': ['Brest', 'Lorient', 'Rennes', 'Saint-Malo'],
  'FR-ARA': ['Lyon', 'Grenoble', 'Saint-Étienne'],
  'FR-OCC': ['Sète', 'Toulouse', 'Montpellier', 'Port-la-Nouvelle'],
  'FR-GES': ['Strasbourg', 'Metz', 'Reims'],
  'FR-BFC': ['Dijon', 'Besançon'],
  'FR-CVL': ['Orléans', 'Tours'],

  // --- United Kingdom -------------------------------------------------------
  'GB-ENG': ['Felixstowe', 'Southampton', 'London Gateway', 'Liverpool', 'Immingham', 'Dover', 'Bristol', 'Teesport'],
  'GB-SCT': ['Grangemouth', 'Aberdeen', 'Glasgow', 'Edinburgh'],
  'GB-WLS': ['Cardiff', 'Milford Haven', 'Holyhead', 'Swansea'],
  'GB-NIR': ['Belfast', 'Londonderry', 'Warrenpoint'],

  // --- Greece ---------------------------------------------------------------
  'GR-A': ['Piraeus', 'Athens', 'Elefsina'],
  'GR-B': ['Thessaloniki', 'Kavala'],
  'GR-M': ['Heraklion', 'Chania'],
  'GR-L': ['Rhodes', 'Syros'],
  'GR-K': ['Mytilene', 'Chios'],

  // --- Hong Kong / Singapore (no subdivisions) -------------------------------
  HK: ['Hong Kong', 'Kwai Tsing', 'Kowloon', 'Tsuen Wan'],
  SG: ['Singapore', 'Jurong', 'Tuas', 'Pasir Panjang'],

  // --- Indonesia ------------------------------------------------------------
  'ID-JK': ['Jakarta', 'Tanjung Priok'],
  'ID-JB': ['Bandung', 'Bekasi', 'Cirebon'],
  'ID-JI': ['Surabaya', 'Tanjung Perak', 'Malang'],
  'ID-JT': ['Semarang', 'Tanjung Emas', 'Solo'],
  'ID-SU': ['Medan', 'Belawan'],
  'ID-KI': ['Balikpapan', 'Samarinda'],
  'ID-BA': ['Denpasar', 'Benoa'],

  // --- Ireland --------------------------------------------------------------
  'IE-D': ['Dublin'],
  'IE-C': ['Cork', 'Ringaskiddy'],
  'IE-LK': ['Limerick', 'Foynes'],
  'IE-WD': ['Waterford'],
  'IE-G': ['Galway'],

  // --- India ----------------------------------------------------------------
  'IN-TN': ['Chennai', 'Ennore', 'Tuticorin', 'Coimbatore', 'Madurai', 'Tiruchirappalli'],
  'IN-MH': ['Mumbai', 'Nhava Sheva', 'Pune', 'Nagpur', 'Nashik'],
  'IN-GJ': ['Mundra', 'Kandla', 'Ahmedabad', 'Surat', 'Hazira', 'Vadodara'],
  'IN-KA': ['Bengaluru', 'Mangaluru', 'Mysuru', 'Hubballi'],
  'IN-KL': ['Kochi', 'Vallarpadam', 'Thiruvananthapuram', 'Kozhikode'],
  'IN-WB': ['Kolkata', 'Haldia', 'Durgapur', 'Siliguri'],
  'IN-AP': ['Visakhapatnam', 'Krishnapatnam', 'Kakinada', 'Vijayawada'],
  'IN-TG': ['Hyderabad', 'Warangal', 'Secunderabad'],
  'IN-OR': ['Paradip', 'Bhubaneswar', 'Dhamra', 'Cuttack'],
  'IN-GA': ['Mormugao', 'Panaji', 'Vasco da Gama'],
  'IN-DL': ['New Delhi', 'Delhi'],
  'IN-UP': ['Lucknow', 'Kanpur', 'Noida', 'Agra', 'Varanasi'],
  'IN-HR': ['Gurugram', 'Faridabad', 'Panipat', 'Ambala'],
  'IN-PB': ['Ludhiana', 'Amritsar', 'Jalandhar'],
  'IN-RJ': ['Jaipur', 'Jodhpur', 'Udaipur', 'Kota'],
  'IN-MP': ['Indore', 'Bhopal', 'Jabalpur'],
  'IN-BR': ['Patna', 'Gaya', 'Muzaffarpur'],
  'IN-JH': ['Ranchi', 'Jamshedpur', 'Dhanbad'],
  'IN-CT': ['Raipur', 'Bhilai', 'Bilaspur'],
  'IN-AS': ['Guwahati', 'Dibrugarh', 'Silchar'],
  'IN-UT': ['Dehradun', 'Haridwar', 'Rudrapur'],
  'IN-HP': ['Shimla', 'Baddi', 'Solan'],
  'IN-JK': ['Srinagar', 'Jammu'],
  'IN-CH': ['Chandigarh'],
  'IN-PY': ['Puducherry', 'Karaikal'],
  'IN-AN': ['Port Blair'],
  'IN-LD': ['Kavaratti'],
  'IN-LA': ['Leh', 'Kargil'],
  'IN-DH': ['Daman', 'Silvassa', 'Diu'],
  'IN-AR': ['Itanagar'],
  'IN-MN': ['Imphal'],
  'IN-ML': ['Shillong'],
  'IN-MZ': ['Aizawl'],
  'IN-NL': ['Kohima', 'Dimapur'],
  'IN-SK': ['Gangtok'],
  'IN-TR': ['Agartala'],

  // --- Italy ----------------------------------------------------------------
  'IT-42': ['Genoa', 'La Spezia', 'Savona'],
  'IT-25': ['Milan', 'Bergamo', 'Brescia'],
  'IT-34': ['Venice', 'Verona', 'Padua', 'Chioggia'],
  'IT-36': ['Trieste', 'Monfalcone', 'Udine'],
  'IT-72': ['Naples', 'Salerno', 'Castellammare di Stabia'],
  'IT-62': ['Rome', 'Civitavecchia', 'Gaeta'],
  'IT-52': ['Livorno', 'Florence', 'Piombino'],
  'IT-82': ['Palermo', 'Catania', 'Augusta', 'Messina'],
  'IT-75': ['Bari', 'Taranto', 'Brindisi'],
  'IT-45': ['Ravenna', 'Bologna', 'Rimini'],
  'IT-21': ['Turin', 'Novara'],
  'IT-88': ['Cagliari', 'Olbia', 'Porto Torres'],

  // --- Japan ----------------------------------------------------------------
  'JP-13': ['Tokyo'],
  'JP-14': ['Yokohama', 'Kawasaki', 'Kanagawa'],
  'JP-27': ['Osaka', 'Sakai'],
  'JP-28': ['Kobe', 'Himeji', 'Amagasaki'],
  'JP-23': ['Nagoya', 'Toyohashi', 'Kinuura'],
  'JP-40': ['Hakata', 'Kitakyushu', 'Fukuoka'],
  'JP-01': ['Tomakomai', 'Sapporo', 'Hakodate'],
  'JP-33': ['Mizushima', 'Okayama'],

  // --- Kenya ----------------------------------------------------------------
  'KE-30': ['Mombasa'],
  'KE-47': ['Nairobi'],
  'KE-28': ['Kilifi', 'Malindi'],
  'KE-32': ['Nakuru', 'Naivasha'],

  // --- South Korea ----------------------------------------------------------
  'KR-26': ['Busan'],
  'KR-28': ['Incheon'],
  'KR-11': ['Seoul'],
  'KR-31': ['Ulsan'],
  'KR-41': ['Pyeongtaek', 'Suwon', 'Gwangyang'],
  'KR-48': ['Changwon', 'Masan'],

  // --- Sri Lanka ------------------------------------------------------------
  'LK-1': ['Colombo', 'Negombo'],
  'LK-3': ['Hambantota', 'Galle'],
  'LK-2': ['Kandy'],
  'LK-5': ['Trincomalee', 'Batticaloa'],
  'LK-6': ['Puttalam', 'Kurunegala'],

  // --- Morocco --------------------------------------------------------------
  'MA-01': ['Tangier', 'Tanger Med', 'Tetouan'],
  'MA-06': ['Casablanca', 'Mohammedia', 'Settat'],
  'MA-09': ['Agadir'],
  'MA-04': ['Rabat', 'Kenitra'],

  // --- Mexico ---------------------------------------------------------------
  'MX-VER': ['Veracruz', 'Coatzacoalcos', 'Tuxpan'],
  'MX-CMX': ['Mexico City'],
  'MX-BCN': ['Ensenada', 'Tijuana', 'Mexicali'],
  'MX-JAL': ['Guadalajara', 'Puerto Vallarta'],
  'MX-NLE': ['Monterrey', 'Salinas Victoria'],
  'MX-SIN': ['Mazatlán', 'Topolobampo', 'Culiacán'],
  'MX-TAM': ['Altamira', 'Tampico', 'Matamoros'],
  'MX-MIC': ['Lázaro Cárdenas', 'Morelia'],
  'MX-QUE': ['Querétaro'],
  'MX-YUC': ['Progreso', 'Mérida'],

  // --- Malaysia -------------------------------------------------------------
  'MY-10': ['Port Klang', 'Shah Alam', 'Klang'],
  'MY-07': ['Penang', 'Butterworth', 'George Town'],
  'MY-01': ['Tanjung Pelepas', 'Johor Bahru', 'Pasir Gudang'],
  'MY-14': ['Kuala Lumpur'],
  'MY-12': ['Kota Kinabalu', 'Sandakan'],
  'MY-13': ['Kuching', 'Bintulu', 'Miri'],
  'MY-08': ['Ipoh', 'Lumut'],

  // --- Nigeria --------------------------------------------------------------
  'NG-LA': ['Lagos', 'Apapa', 'Tin Can Island', 'Lekki'],
  'NG-RI': ['Port Harcourt', 'Onne'],
  'NG-FC': ['Abuja'],
  'NG-KN': ['Kano'],

  // --- Netherlands ----------------------------------------------------------
  'NL-ZH': ['Rotterdam', 'The Hague', 'Dordrecht', 'Maasvlakte'],
  'NL-NH': ['Amsterdam', 'IJmuiden', 'Haarlem', 'Beverwijk'],
  'NL-NB': ['Eindhoven', 'Moerdijk', 'Tilburg', "'s-Hertogenbosch"],
  'NL-ZE': ['Vlissingen', 'Terneuzen', 'Middelburg'],
  'NL-GR': ['Groningen', 'Delfzijl', 'Eemshaven'],
  'NL-UT': ['Utrecht', 'Amersfoort'],
  'NL-GE': ['Nijmegen', 'Arnhem', 'Apeldoorn'],
  'NL-OV': ['Enschede', 'Zwolle', 'Hengelo'],
  'NL-LI': ['Maastricht', 'Venlo', 'Sittard'],
  'NL-FL': ['Almere', 'Lelystad'],
  'NL-FR': ['Leeuwarden', 'Harlingen'],
  'NL-DR': ['Assen', 'Emmen'],

  // --- Norway ---------------------------------------------------------------
  'NO-03': ['Oslo'],
  'NO-11': ['Stavanger', 'Sandnes', 'Haugesund'],
  'NO-46': ['Bergen', 'Ålesund'],
  'NO-50': ['Trondheim', 'Orkanger'],
  'NO-15': ['Molde', 'Kristiansund'],

  // --- New Zealand ----------------------------------------------------------
  'NZ-AUK': ['Auckland'],
  'NZ-BOP': ['Tauranga', 'Mount Maunganui'],
  'NZ-CAN': ['Christchurch', 'Lyttelton', 'Timaru'],
  'NZ-WGN': ['Wellington', 'Lower Hutt'],
  'NZ-OTA': ['Dunedin', 'Port Chalmers'],

  // --- Oman -----------------------------------------------------------------
  'OM-MA': ['Muscat', 'Muttrah'],
  'OM-ZU': ['Salalah'],
  'OM-BS': ['Sohar', 'Shinas'],
  'OM-BJ': ['Barka', 'Rustaq'],

  // --- Panama ---------------------------------------------------------------
  'PA-8': ['Panama City', 'Balboa'],
  'PA-3': ['Colón', 'Cristóbal', 'Manzanillo'],
  'PA-4': ['David', 'Puerto Armuelles'],

  // --- Philippines ----------------------------------------------------------
  'PH-00': ['Manila', 'Makati', 'Quezon City'],
  'PH-07': ['Cebu', 'Mandaue', 'Lapu-Lapu'],
  'PH-11': ['Davao'],
  'PH-03': ['Subic', 'Angeles', 'Clark'],
  'PH-04': ['Batangas', 'Calamba', 'Cavite'],

  // --- Poland ---------------------------------------------------------------
  'PL-22': ['Gdańsk', 'Gdynia', 'Sopot'],
  'PL-32': ['Szczecin', 'Świnoujście'],
  'PL-14': ['Warsaw', 'Płock'],
  'PL-12': ['Kraków', 'Tarnów'],
  'PL-02': ['Wrocław', 'Legnica'],

  // --- Portugal -------------------------------------------------------------
  'PT-11': ['Lisbon', 'Setúbal', 'Sines'],
  'PT-13': ['Porto', 'Leixões', 'Matosinhos'],
  'PT-08': ['Faro', 'Portimão'],
  'PT-16': ['Viana do Castelo'],

  // --- Qatar ----------------------------------------------------------------
  'QA-DA': ['Doha', 'Hamad Port'],
  'QA-RA': ['Al Rayyan', 'Mesaieed'],
  'QA-MS': ['Ras Laffan', 'Al Ruwais'],

  // --- Saudi Arabia ---------------------------------------------------------
  'SA-02': ['Jeddah', 'Mecca', 'Rabigh', 'King Abdullah Port'],
  'SA-04': ['Dammam', 'Jubail', 'Khobar', 'Ras Tanura'],
  'SA-01': ['Riyadh'],
  'SA-03': ['Medina', 'Yanbu'],
  'SA-14': ['Abha', 'Jizan'],

  // --- Sweden ---------------------------------------------------------------
  'SE-O': ['Gothenburg', 'Uddevalla', 'Varberg'],
  'SE-AB': ['Stockholm', 'Södertälje', 'Norvik'],
  'SE-M': ['Malmö', 'Helsingborg', 'Trelleborg'],
  'SE-E': ['Norrköping', 'Linköping'],

  // --- Thailand -------------------------------------------------------------
  'TH-10': ['Bangkok', 'Klong Toey'],
  'TH-20': ['Laem Chabang', 'Chonburi', 'Si Racha', 'Pattaya'],
  'TH-83': ['Phuket'],
  'TH-90': ['Songkhla', 'Hat Yai'],
  'TH-50': ['Chiang Mai'],

  // --- Türkiye --------------------------------------------------------------
  'TR-34': ['Istanbul', 'Ambarli', 'Haydarpasa'],
  'TR-35': ['Izmir', 'Aliaga', 'Nemrut Bay'],
  'TR-33': ['Mersin', 'Tasucu'],
  'TR-01': ['Adana', 'Iskenderun', 'Ceyhan'],
  'TR-16': ['Bursa', 'Gemlik', 'Mudanya'],

  // --- United States --------------------------------------------------------
  'US-CA': ['Los Angeles', 'Long Beach', 'Oakland', 'San Francisco', 'San Diego', 'Sacramento'],
  'US-NY': ['New York', 'Brooklyn', 'Albany', 'Buffalo'],
  'US-NJ': ['Newark', 'Elizabeth', 'Jersey City', 'Camden'],
  'US-TX': ['Houston', 'Galveston', 'Corpus Christi', 'Dallas', 'Laredo', 'El Paso'],
  'US-FL': ['Miami', 'Jacksonville', 'Port Everglades', 'Tampa', 'Orlando'],
  'US-GA': ['Savannah', 'Atlanta', 'Brunswick'],
  'US-SC': ['Charleston', 'Georgetown', 'Columbia'],
  'US-VA': ['Norfolk', 'Portsmouth', 'Richmond', 'Newport News'],
  'US-WA': ['Seattle', 'Tacoma', 'Everett', 'Spokane'],
  'US-OR': ['Portland', 'Coos Bay', 'Astoria'],
  'US-LA': ['New Orleans', 'Baton Rouge', 'Lake Charles', 'Gramercy'],
  'US-IL': ['Chicago', 'Joliet', 'Peoria'],
  'US-MD': ['Baltimore', 'Annapolis'],
  'US-PA': ['Philadelphia', 'Pittsburgh', 'Chester'],
  'US-MA': ['Boston', 'New Bedford', 'Worcester'],
  'US-AL': ['Mobile', 'Birmingham', 'Montgomery'],
  'US-AK': ['Anchorage', 'Dutch Harbor', 'Juneau'],
  'US-AZ': ['Phoenix', 'Tucson', 'Nogales'],
  'US-AR': ['Little Rock', 'Fort Smith'],
  'US-CO': ['Denver', 'Colorado Springs'],
  'US-CT': ['New Haven', 'Bridgeport', 'Hartford'],
  'US-DE': ['Wilmington', 'Dover'],
  'US-DC': ['Washington'],
  'US-HI': ['Honolulu', 'Hilo', 'Kahului'],
  'US-ID': ['Boise', 'Lewiston'],
  'US-IN': ['Indianapolis', 'Burns Harbor', 'Fort Wayne'],
  'US-IA': ['Des Moines', 'Davenport'],
  'US-KS': ['Wichita', 'Kansas City'],
  'US-KY': ['Louisville', 'Lexington', 'Paducah'],
  'US-ME': ['Portland', 'Searsport', 'Eastport'],
  'US-MI': ['Detroit', 'Grand Rapids', 'Muskegon'],
  'US-MN': ['Duluth', 'Minneapolis', 'St. Paul'],
  'US-MS': ['Gulfport', 'Pascagoula', 'Jackson'],
  'US-MO': ['St. Louis', 'Kansas City', 'Springfield'],
  'US-MT': ['Billings', 'Great Falls'],
  'US-NE': ['Omaha', 'Lincoln'],
  'US-NV': ['Las Vegas', 'Reno'],
  'US-NH': ['Portsmouth', 'Manchester'],
  'US-NM': ['Albuquerque', 'Santa Teresa'],
  'US-NC': ['Wilmington', 'Charlotte', 'Morehead City', 'Raleigh'],
  'US-ND': ['Fargo', 'Bismarck'],
  'US-OH': ['Cleveland', 'Toledo', 'Columbus', 'Cincinnati'],
  'US-OK': ['Tulsa', 'Oklahoma City', 'Catoosa'],
  'US-PR': ['San Juan', 'Ponce'],
  'US-RI': ['Providence', 'Davisville'],
  'US-SD': ['Sioux Falls', 'Rapid City'],
  'US-TN': ['Memphis', 'Nashville', 'Knoxville'],
  'US-UT': ['Salt Lake City', 'Ogden'],
  'US-VT': ['Burlington'],
  'US-WV': ['Huntington', 'Charleston'],
  'US-WI': ['Milwaukee', 'Green Bay', 'Superior'],
  'US-WY': ['Cheyenne', 'Casper'],

  // --- Vietnam --------------------------------------------------------------
  'VN-SG': ['Ho Chi Minh City', 'Cat Lai'],
  'VN-HP': ['Haiphong', 'Lach Huyen'],
  'VN-BR': ['Cai Mep', 'Vung Tau', 'Phu My'],
  'VN-DN': ['Da Nang', 'Tien Sa'],
  'VN-HN': ['Hanoi'],

  // --- South Africa ---------------------------------------------------------
  'ZA-WC': ['Cape Town', 'Saldanha Bay', 'Mossel Bay'],
  'ZA-KZN': ['Durban', 'Richards Bay', 'Pietermaritzburg'],
  'ZA-EC': ['Port Elizabeth', 'Ngqura', 'East London'],
  'ZA-GP': ['Johannesburg', 'Pretoria', 'City Deep'],
  'ZA-FS': ['Bloemfontein'],
  'ZA-MP': ['Nelspruit', 'Komatipoort'],
  'ZA-LP': ['Polokwane'],
  'ZA-NW': ['Rustenburg', 'Mahikeng'],
  'ZA-NC': ['Kimberley', 'Upington'],
};

/** The key a city list is stored under. */
export const cityKey = (countryCode, stateCode) =>
  stateCode ? `${countryCode}-${stateCode}` : countryCode;

/**
 * Cities for a country/subdivision pair, alphabetically sorted.
 *
 * Returns an empty array when nothing is curated for that pair. Callers must
 * treat that as "no suggestions available", never as "no valid cities exist" -
 * the UI falls back to free text and the backend accepts it.
 */
export function citiesFor(countryCode, stateCode) {
  const list = CITIES[cityKey(countryCode, stateCode)];
  return list ? [...list].sort((a, b) => a.localeCompare(b)) : [];
}

/**
 * Whether a city appears in the curated list.
 *
 * Used only to decide how the UI presents the value (list selection versus
 * "Other"). It is deliberately **not** used to reject input - see the note at
 * the top of this file.
 */
export function isKnownCity(countryCode, stateCode, city) {
  if (typeof city !== 'string') return false;
  const wanted = city.trim().toLowerCase();
  return citiesFor(countryCode, stateCode).some((name) => name.toLowerCase() === wanted);
}

/** The full map, shaped for the meta endpoint. */
export function cityCatalogue() {
  return CITIES;
}

export const CITY_COVERAGE = Object.freeze({
  keys: Object.keys(CITIES).length,
  cities: Object.values(CITIES).reduce((total, list) => total + list.length, 0),
});
