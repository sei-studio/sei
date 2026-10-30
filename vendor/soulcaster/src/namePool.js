// Given-name pool for the soulcaster character generator.
//
// Why this exists: when the model picked names freely it mode-collapsed hard
// (prod 261027: 705 companions, only 358 distinct names; Akane x32, Priya x18,
// Soren x17, two public characters both named "Chen Wei"). Code now draws a
// handful of random candidates from this pool (drawNames.ts) and the model
// picks the best fit among them, so variety comes from real randomness instead
// of the model's favourite few names.
//
// Source: written by hand for Sei (no third-party list was copied), so it is
// ours to ship. Given names only, no surnames. Keyed by the soulcaster
// HERITAGES values (soulcaster/src/tables.js) and split by gender
// presentation. "unisex" names are drawn for every gender. Within a heritage
// a name should appear in only one of the three lists; the same name may
// appear under two heritages (e.g. Elena).
//
// Romanization: Korean uses hyphenated given names (Seo-yeon), Chinese uses
// toneless pinyin written as one word (Mingyu). Plain ASCII letters only (no
// diacritics): a generated character has no username, so its Minecraft name
// is name.replace(/[^A-Za-z0-9_]/g, '') and "Sofía" would become "Sofa".
// Hyphens are fine ("Min-jun" plays as "Minjun"). Every name must also
// sanitize to 3-16 characters, the Minecraft username length range.
//
// KEEP IN SYNC: this is a copy of sei-proxy src/anthropic/names/namePool.ts
// (the cloud path draws there; this copy serves BYOK/local casts). Edit both
// together; the data block below is identical.

/** @type {Record<string, { female: string, male: string, unisex: string }>} */
export const NAME_POOL_SOURCE = {
  japanese: {
    female: `
      Aiko Akemi Akiko Akane Ami Asuka Ayaka Ayame Ayano Chiaki Chie Chihiro Chika Chiyo Emi Eri
      Fumiko Fuyumi Fuuka Hana Hanae Haruka Haruna Hatsue Hikari Hina Hiromi Hisae Hitomi Honoka
      Ichika Junko Kaede Kana Kanae Kanako Kaori Kasumi Kayo Kazue Keiko Kiyomi Kohana Kotomi
      Kotone Kumiko Kyoko Machiko Madoka Mai Maki Mana Manami Mao Mariko Masami Mayu Mayumi Megumi
      Mei Michiru Midori Mieko Mika Miki Minako Minori Misaki Mitsuko Miyako Miyu Mutsumi Nanami
      Natsuki Natsumi Noriko Nozomi Otoha Reiko Rena Rie Rika Rin Rina Rino Risa Ruri Sachiko Saki
      Sakie Sakura Sanae Satomi Sawako Sayaka Sayuri Setsuko Shiho Shino Shiori Shizuka Sumire
      Suzu Suzune Tae Tamaki Tomoe Tomoko Tsubaki Tsugumi Ume Wakana Yae Yayoi Yoko Yoshiko Yui
      Yuika Yukari Yukiko Yumeko Yuna Yuriko Yuzuha Akari Asami Hazuki Kiku Momoka Momoko Nao
      Naoko Izumi Mizuki
    `,
    male: `
      Akihiro Akio Arata Atsushi Daichi Daiki Daisuke Eiji Fumio Gen Genji Ginji Goro Hajime
      Haruki Haruomi Haruto Hayato Hideaki Hideki Hideo Hiroki Hiroshi Hiroto Hisashi Ichiro Ikki
      Isamu Isao Jiro Junichi Kaito Kazuki Kazuma Kazuo Keiji Keisuke Ken Kenji Kenta Kentaro
      Kichiro Kiyoshi Koichi Koji Kosuke Kota Kotaro Kunio Kyosuke Mamoru Masahiro Masaki Masao
      Masaru Masato Michio Minoru Mitsuo Naoki Naoto Noboru Nobuo Osamu Renji Rentaro Riku Rikuto
      Ryo Ryohei Ryota Ryuji Ryunosuke Saburo Satoshi Seiji Shigeru Shin Shingo Shinji Shiro Shota
      Shuhei Shun Soichiro Sosuke Susumu Tadashi Takahiro Takeru Takeshi Takumi Takuya Taro
      Tatsuya Teruo Tetsuya Tomohiro Tomoya Torahiko Toru Toshio Wataru Yamato Yasuo Yoshiki
      Yoshio Yosuke Yuichi Yukio Yuma Yusuke Yuta Yuto Zenji Hayate Kaname Kiyotaka Raiden
    `,
    unisex: `
      Akira Aoi Amane Asahi Chiharu Chihaya Haru Hikaru Hinata Hiro Hotaru Itsuki Jun Kanata Kaoru
      Kazumi Kei Kou Makoto Masumi Michi Mikoto Mitsuki Nagisa Natsu Rei Ren Rui Shinobu Sora
      Tomomi Tsubasa Tsukasa Yuki Yuu Yuzu
    `,
  },

  korean: {
    female: `
      Seo-yeon Seo-hyun Seo-ah Ji-ah Ji-eun Ji-hye Ji-yoon Ji-an Min-ji Min-seo Min-ah Su-bin
      Su-ah Su-jin Soo-min Ha-eun Ha-yoon Ha-rin Ha-na Ha-jin Ha-young Ye-jin Ye-eun Ye-won Ye-seo
      Yoon-ah Yu-na Eun-ji Eun-bi Eun-seo Eun-young Eun-ha Eun-chae Hye-jin Hye-won Hye-rin
      Hye-soo Hee-jin Hee-young Hyun-ah Hyun-joo Da-eun Da-hye Da-som Na-yeon Na-rae Na-eun Bo-ra
      Bo-young Bo-eun Bo-mi Chae-won Chae-young Chae-rin So-yeon So-hee So-young So-ra So-mi
      Ga-eun Ga-young Ga-in In-hye Jae-hee Joo-hee Mi-rae Mi-jin Mi-kyung Mi-na Kyung-ah Kyung-hee
      Sun-hee Sun-young Sae-rom Se-ah Se-young Si-eun Si-ah A-reum A-yeon Yeon-hee Jung-ah
      Jung-eun Young-hee Young-mi Myung-hee Hwa-young Bit-na Seul-gi Seul-ah Ae-ri Dal-bi Jin-hee
      Jin-ah Ri-na Yoo-jung Hyo-jin Hyo-rin Hyo-joo Yun-seo Do-hee Ah-young Ju-yeon Dan-bi Ye-rin
      Soo-jung Mi-sun Eun-hye Hae-in Ra-hee
    `,
    male: `
      Min-jun Min-ho Min-jae Min-seok Min-woo Seo-jun Seo-jin Do-yoon Do-hyun Do-hoon Ji-ho
      Ji-hoon Ji-hwan Ji-sung Jun-ho Jun-young Jun-seo Jae-hyun Jae-won Jae-sung Jae-min Jae-yong
      Jae-wook Hyun-woo Hyun-jun Hyun-soo Hyun-sik Sung-min Sung-ho Sung-jin Sung-hoon Sung-jae
      Seung-woo Seung-hyun Seung-ho Seung-min Tae-yang Tae-hyun Tae-min Tae-hoon Tae-woo Woo-jin
      Woo-hyun Woo-sung Young-ho Young-jae Young-soo Young-min Dong-hyun Dong-wook Dong-ha
      Kang-min Kyung-soo Kyung-ho Kyung-tae Byung-hun Chang-min Chang-wook Dae-hyun Dae-sung
      Geon-woo Geon-ho Ho-jin Ho-seok Jong-hyun Jong-in Jong-su Joo-won Kwang-soo Kyu-hyun
      Myung-soo Sang-woo Sang-hoon Sang-min Sang-yoon Si-woo Si-hyun Su-ho Won-bin Won-ho Yong-hwa
      Yoon-ho Yu-chan Eun-woo Hae-jin Han-gyeol Hyung-sik In-sung Il-woo Jin-woo Jin-young
      Jin-hyuk Ki-tae Ki-bum Nam-gil Byeong-cheol Chul-soo Hee-chul Jeong-ho Myeong-jin Ye-jun
      Yeong-su Ha-jun Joon-ki Moon-su Sung-wook Hwan
    `,
    unisex: `
      Ji-min Ji-won Ji-soo Ji-woo Ha-neul Yu-jin Se-jin Yeon-woo Ra-on Han-byeol Seo-woo Hae-won
      Eun-sol Ha-ram Ga-ram Ba-da Sol Bom Byeol Ha-ru Ye-sol Su-hyun Hyun-jin Min-gyeol Da-on
    `,
  },

  chinese: {
    female: `
      Xiaoling Xiaomei Meilin Meiling Lihua Lijuan Lili Linlin Ling Mei Yan Yanling Yating Yifei
      Yiting Yuxin Yuqi Yuyan Ziyi Xinyi Xinyue Xiaoxue Xue Xueqin Shuang Shufen Siqi Sitong Ruoxi
      Ruolan Qian Qiaoyi Peiyu Nuo Mengyao Mengqi Lanfang Lan Jingyi Jingwen Jiayi Jiaxin Huiying
      Huimin Hong Hanxue Fang Fei Dandan Chunhua Bingbing Anqi Wanting Wanqing Wenjing Wenxin
      Xiaohong Xiaojing Xiaoqing Xiaotong Xiaowen Xinran Xuan Yaqin Yawen Yihan Yimeng Yingying
      Yue Yuhan Yulan Yun Yuying Zhen Zhihui Zhiruo Ziqi Shiyu Shihan Shanshan Qiuyue Muqing
      Mingyue Huan Jiahui Liqin Peiling Ruyi Suyin Tingting Xiaolan Yanyan Yiwen Lingling Xiuying
      Jiamin Shuyi Yuelin Qingyi
    `,
    male: `
      Bowen Dawei Deming Feng Gang Guang Haoran Haoyu Hao Heng Hongwei Jian Jianguo Jianhua Jiahao
      Jiale Jiaming Jie Jin Jinhai Junjie Junhao Kai Kang Lei Liang Long Ming Mingyu Minghao Peng
      Qiang Qiming Rui Shaowei Shen Tao Tianyu Wenbo Wenjie Wenhao Xiang Xiaobo Xiaojun Xiaolong
      Yang Yifan Yihang Yong Yuchen Yuhang Yunfei Zhiwei Zhiqiang Zhihao Zihao Zimo Zirui Zeyu
      Zhenyu Haoxuan Hanwen Guowei Chenyu Boyang Junwei Kaiwen Liwei Mingxuan Ruochen Siyuan
      Tianhao Weiming Xiaoming Xingyu Yansong Yiming Yuze Zhengyang Hongyu Jianyu Kun Shuo Song
      Wenxuan Zhiyuan Huaqiang Jingyu Lixin Pengfei Shengli Weidong Yuanhang Zhongyi
    `,
    unisex: `
      Wei Hua Tian Xin Qing Yutong Zihan Jiaqi Chenxi Zixuan Xiaoyu Yuan Lingyun Ning Ruoyu Siyu
      Jun Yunxi Jing
    `,
  },

  'south-asian': {
    female: `
      Aanya Aarti Aditi Akshara Ananya Anika Anjali Anushka Aparna Archana Avni Bhavna Chandni
      Charu Deepa Deepika Devika Diya Divya Esha Gauri Gayatri Geeta Hema Indira Ira Isha Kajal
      Kalpana Kamala Kavya Kriti Lakshmi Lata Leela Madhuri Mahima Malini Manisha Meena Meera
      Nalini Namita Nandini Neha Nikita Nisha Padma Pallavi Pooja Prachi Preeti Priya Priyanka
      Radha Radhika Rani Rashmi Ritu Rohini Ruchi Sakshi Sanjana Sapna Saraswati Sarika Savitri
      Seema Shalini Shanti Shilpa Shreya Shruti Sita Smita Sneha Sonali Sunita Swati Tanvi Tara
      Trisha Uma Urvashi Usha Vaishnavi Vandana Vidya Yamini Nazia Nusrat Rukhsana Shabnam Sadia
      Tahmina Mehreen Ayesha Dilini Nimali Tharushi Sachini Sarita Moumita Rituparna Sohini
      Tanushree Ishani Kayal Meenakshi Nithya Revathi Saranya Yazhini Jaya Simran Avani Dhara
    `,
    male: `
      Aarav Abhishek Aditya Ajay Akash Amit Anand Aniket Anil Anirudh Arjun Arnav Ashok Ashwin
      Ayaan Bharat Chetan Darshan Deepak Dev Dhruv Ganesh Gaurav Govind Harish Harsh Ishaan Jai
      Jaidev Karan Kartik Krishna Kunal Lakshman Madhav Mahesh Manoj Mohan Mukesh Naveen Nikhil
      Nitin Omkar Pranav Prakash Prem Rahul Raj Rajesh Rakesh Ravi Rishi Rohan Rohit Sachin Sagar
      Sahil Sameer Sandeep Sanjay Satya Shiv Siddharth Sunil Suresh Tarun Tejas Varun Vihaan Vijay
      Vikram Vinay Vivek Yash Yuvraj Faisal Imran Irfan Junaid Shoaib Usman Zubair Asif Kamran
      Harjeet Balwinder Kasun Chaminda Lahiru Nuwan Dinesh Arindam Sourav Anirban Debashish Partha
      Karthik Senthil Murugan Venkat Selvam Ilango Bikash Prabin Hamid Kamal Inder Ashmit
    `,
    unisex: `
      Kiran Amrit Gurpreet Manpreet Jaspreet Harpreet Navjot Navdeep Shashi Arya Sunny Noor Rumi
      Mani Jyoti Sukhmani Prabhjot
    `,
  },

  nordic: {
    female: `
      Agnete Alva Anja Astrid Asta Birgit Bodil Brynja Dagny Ebba Edda Eira Elin Elsa Embla Erika
      Freja Frida Gerd Greta Gudrun Gunnhild Hanna Hedda Helga Hilde Hulda Idun Inga Ingeborg
      Ingrid Jorunn Karin Kari Katla Kirsten Linnea Liv Maja Malin Margit Marit Nanna Oda Ragna
      Ragnhild Randi Ronja Runa Saga Sigrid Signe Silje Siv Solveig Sunniva Svea Thora Tilde Tove
      Tuva Turid Ulla Unn Vigdis Vilja Wilma Ylva Aino Aili Hilja Kaisa Lempi Minna Noora Satu
      Sanna Tuuli Vappu Hekla Halla Bryndis Katrin Sunna Mette Lotte Pernille Sofie Stine Trine
      Ida Klara Annika Hedvig Elvira Ottilia
    `,
    male: `
      Anders Arne Arvid Asger Axel Bjarne Bjorn Eirik Einar Erik Espen Finn Frode Gunnar Gustav
      Hakon Halvard Halvor Hans Harald Henrik Ivar Jarl Jens Joakim Kjell Knut Lars Leif Magnus
      Mats Mikkel Nils Olav Oskar Ove Per Ragnar Rasmus Rolf Rune Sigurd Sindre Sten Steinar Stig
      Sune Svein Sverre Tor Torbjorn Torsten Torvald Trygve Ulf Vidar Viggo Vilhelm Yngve Aatu
      Eino Ilmari Jussi Kalle Lauri Mikko Onni Otso Sampo Tapio Toivo Veikko Vaino Arnar Gisli
      Hrafn Snorri Halldor Egill Soren Morten Kasper Mads Torben Emil Elias Hugo Sixten Algot Ebbe
      Eskil Love Vide Kai
    `,
    unisex: `
      Kim Robin Mio Sol Lumi Aamu Noa Eli Sky Alex Ilo
    `,
  },

  slavic: {
    female: `
      Agata Agnieszka Alena Alina Alla Anastasia Anfisa Anya Darina Darya Dominika Dragana
      Ekaterina Elena Eva Galina Halina Irina Ivana Jadwiga Jana Jelena Kalina Karolina Katya Kira
      Klara Ksenia Lada Lara Larisa Lena Lidia Lilia Lyudmila Malgorzata Marina Marta Masha Milena
      Milica Mira Miroslava Nadia Nadezhda Natasha Nika Nina Oksana Olesya Olga Petra Polina Radka
      Raisa Snezhana Sofia Svetlana Tamara Tanya Tatiana Valentina Vera Veronika Vesna Viktoria
      Vlasta Yana Yulia Zdenka Zlata Zofia Zora Zoya Bogdana Danica Jaroslava Radmila Stanislava
      Ulyana Varvara Wanda Yaroslava Iva Rada Lyuba Bozena Katarzyna Kasia Magda Dunja Jovana Mila
      Teodora Ilona Alisa Inna Kseniya Lesya
    `,
    male: `
      Aleksandr Aleksei Anatoly Andrej Anton Arkady Bogdan Boris Bronislav Damir Danil Denis
      Dmitri Dobromir Dragan Dusan Fedor Filip Gennady Gleb Goran Grigori Igor Ilya Ivan Jakub Jan
      Jaromir Jaroslav Jerzy Karel Kazimir Konstantin Krzysztof Lev Leonid Lubomir Luka Maksim
      Marek Matvei Mikhail Milan Milos Miroslav Mstislav Nikita Nikolai Oleg Ondrej Pavel Petar
      Piotr Radek Radomir Roman Ruslan Semyon Sergei Stanislav Stefan Svyatoslav Taras Timur Tomas
      Vadim Valentin Vasily Viktor Vitaly Vladimir Vlad Vojtech Wojciech Yaroslav Yegor Yuri
      Zbigniew Zdenek Zoran Rostislav Vsevolod Kostya Mischa Vanya Artem Bohdan Danylo Mykola
      Ostap Jarek Yarik Slava
    `,
    unisex: `
      Sasha Zhenya Valya Nikola Shura Toma Dani Mika
    `,
  },

  'latin-american': {
    female: `
      Adriana Alejandra Alma Ana Andrea Antonella Ariadna Beatriz Camila Carmen Catalina Cecilia
      Constanza Daniela Dolores Esperanza Estela Fernanda Florencia Gabriela Graciela Guadalupe
      Isabela Itzel Jimena Josefina Juana Julieta Karina Leticia Liliana Lorena Lucia Luciana Luz
      Magdalena Maite Marisol Martina Mayra Mercedes Milagros Mirella Natalia Noemi Paloma Paola
      Paula Pilar Rocio Rosa Rosario Salome Sofia Soledad Valentina Valeria Ximena Yesenia Yolanda
      Thais Bianca Larissa Juliana Raissa Taina Iara Jussara Lais Rafaela Mariana Bruna Joana
      Nayeli Xochitl Citlali Yaretzi Killa Ayelen Rayen Millaray Abril Agustina Renata Regina
      Romina Fabiola Dulce Araceli Belen Emilia Lourdes Marcela Viviana Zulema Guada Juli Paz Mar
      Cielo
    `,
    male: `
      Alejandro Andres Antonio Armando Arturo Benicio Bernardo Carlos Cesar Cristian Diego Eduardo
      Emiliano Enrique Esteban Federico Felipe Fernando Francisco Gabriel Gerardo Gonzalo
      Guillermo Gustavo Hector Hernan Hugo Ignacio Javier Joaquin Jorge Jose Juan Julian Leandro
      Leonardo Lorenzo Luis Manuel Marcelo Marco Martin Mateo Matias Mauricio Maximiliano Miguel
      Nicolas Octavio Pablo Patricio Pedro Rafael Ramiro Ramon Raul Ricardo Rodrigo Rogelio
      Salvador Santiago Sebastian Sergio Vicente Thiago Caio Davi Joao Bruno Renato Leonel Inti
      Nahuel Lautaro Amaru Tonatiuh Facundo Agustin Valentin Bautista Emilio Ruben Oscar Ivan
      Damian Ezequiel Tadeo Wilmer Edson Jairo Nico
    `,
    unisex: `
      Cruz Ariel Sol Alexis Reyes Yael Dani Rio Fran Ale
    `,
  },

  'middle-eastern': {
    female: `
      Amal Amani Amira Asma Aya Basma Dalia Dana Dina Farah Fatima Ghada Hala Hanan Haya Hiba Huda
      Iman Jamila Jumana Karima Laila Layla Lamia Lana Lina Lubna Maha Malak Manal Mariam Maya
      Mona Nadine Najla Nawal Nour Rania Rasha Reem Rima Ruba Rula Safa Salma Samira Sana Sara
      Suha Sumaya Tala Yara Yasmin Zahra Zaina Azadeh Golnaz Mahsa Nasrin Parisa Roya Setareh
      Shirin Soraya Taraneh Yasaman Ayla Defne Elif Esra Hande Ipek Melis Nazli Selin Zeynep Asli
      Damla Ebru Ayelet Shira Tamar Liora Hadas Michal Rojin Berivan Leen Ghalia Rawan Dima
      Nisreen Mina Niloufar Ziba Bahar
    `,
    male: `
      Adel Adnan Ahmad Ali Amir Anwar Ayman Bashir Bilal Fadi Faris Farid Ghassan Hadi Hamza
      Hassan Hisham Hussein Ibrahim Idris Imad Issa Jamal Karim Khaled Mahmoud Majid Malik Marwan
      Mazen Mohammed Munir Murad Mustafa Nabil Nader Nasser Omar Qasim Rami Rashid Riyad Saad Said
      Salim Sami Samir Talal Tamer Tariq Wael Walid Yahya Yasin Yousef Zaid Ziad Arash Babak
      Bahram Dariush Farhad Kaveh Kian Navid Omid Payam Reza Rostam Shahin Siavash Baris Burak Can
      Cem Emre Kerem Mert Ozan Tolga Volkan Ari Eitan Gil Itai Noam Oren Yonatan Ido Avi Kawa
      Shvan Hakim Fares Laith Nima Ozgur Hikmet Yuval
    `,
    unisex: `
      Noor Nur Deniz Tal Sahar Eden Shams Ilkay Yagmur Arin Roni Sharon
    `,
  },

  'west-african': {
    female: `
      Abena Adaeze Adanna Adjoa Afia Afua Akosua Ama Amara Aminata Binta Chiamaka Chidinma Chinwe
      Chioma Dzifa Efua Ekua Enyonam Esi Fatoumata Folake Funmilayo Ifeoma Ijeoma Kadiatou Kemi
      Mariama Ngozi Nkechi Nneka Nnenna Omolara Oyinkansola Rokia Sade Simisola Titilayo Yaa
      Yewande Zainab Adwoa Akua Araba Mansa Naa Dede Aissatou Awa Coumba Ndeye Khady Fanta Oumou
      Bisola Eniola Ireti Morenike Tolani Chinyere Ebele Adaku Ozioma Abla Afi Mawusi Esinam Yayra
      Seyram Asantewaa Serwaa Hadiza Halima Amina Zuwaira Salamatu Kudirat Bukola Ronke Tiwalade
      Ayomide Oluchi Amaka Chisom Nkiru Uju
    `,
    male: `
      Kwame Kofi Kwabena Kwaku Kwasi Kojo Kweku Yaw Kobina Kwadwo Ato Fiifi Adebayo Adewale
      Babatunde Bolaji Dapo Femi Gbenga Kayode Kunle Olumide Oluwafemi Segun Tunde Wale Chidi
      Chinedu Chukwudi Chukwuemeka Emeka Ikenna Nnamdi Obinna Ugo Ifeanyi Obi Amadou Abdoulaye
      Boubacar Cheikh Ibrahima Lamine Mamadou Moussa Ousmane Sekou Souleymane Modibo Bakary Seydou
      Babacar Malick Alioune Idrissa Kodjo Kossi Komi Senyo Dela Abubakar Aminu Bello Garba Musa
      Sani Yusuf Kobby Kwesi Ekow Nii Kpakpo Tetteh Akwasi Ayodeji Oluwaseyi Tobenna Ebuka Somto
      Lanre Ade Dayo Ousseynou Pape Demba Sidiki
    `,
    unisex: `
      Ayodele Oluwaseun Temitope Damilola Kafui Kelechi Uchenna Edem Selorm Elikem Nana Adama Yemi
      Ayo Tobi Ifeoluwa Ebun Chidera Ezinne Mawuli Sena Eyram Dumebi Chika
    `,
  },

  anglo: {
    female: `
      Abigail Ada Alice Amelia Annie Beatrice Bella Bethany Bonnie Bridget Caroline Charlotte
      Chloe Daisy Delia Edith Eleanor Eliza Ella Eloise Emily Emma Esme Evelyn Fiona Florence
      Frances Georgia Grace Gwen Hannah Harriet Hazel Heather Holly Imogen Isla Ivy Jane Jenny
      Jessica Josie Julia Katherine Kate Laura Lillian Lily Lucy Lydia Mabel Maddie Maggie Maisie
      Margaret Martha Matilda Maude Megan Mildred Millie Molly Nell Nora Olive Penelope Phoebe
      Poppy Rachel Rebecca Rose Rosalind Ruby Ruth Sadie Sarah Scarlett Sophie Stella Susannah
      Tess Violet Wendy Winifred Willa Zoe Aoife Ciara Niamh Siobhan Maeve Orla Saoirse Roisin
      Eilidh Kirsty Morag Catriona Bronwen Cerys Rhiannon Seren Sian Ffion Brooke Savannah
      Mackenzie Dorothy Agnes Iris Clementine Lottie Edie
    `,
    male: `
      Albert Alfie Alistair Archie Arthur Benjamin Bertie Callum Christopher Colin Daniel David
      Declan Desmond Dominic Duncan Edmund Edward Elliot Ethan Felix Fletcher Frederick Gareth
      Geoffrey George Gilbert Graham Harry Harvey Henry Hugh Isaac Jack Jacob James Jasper Jonah
      Joseph Joshua Jude Kieran Leo Lewis Liam Louis Lucas Malcolm Matthew Max Miles Nathan
      Nathaniel Neil Oliver Owen Patrick Percy Peter Philip Ralph Rhys Robert Rory Rupert Samuel
      Simon Stanley Theo Thomas Toby Tristan Walter Wesley William Wyatt Aidan Cian Cormac Eoin
      Fergus Niall Oisin Ronan Seamus Tadhg Angus Euan Hamish Lachlan Dylan Emrys Gethin Iwan
      Llewellyn Dafydd Brody Cole Hank Wade Ernest Clifford Barnaby Gideon Silas
    `,
    unisex: `
      Alex Avery Bailey Billie Blair Cameron Casey Charlie Dale Drew Ellis Emerson Frankie Harper
      Hayden Jamie Jesse Jordan Jules Kendall Lane Lee Morgan Parker Peyton Quinn Reese Riley
      Robin Rowan Sam Sawyer Sidney Skyler Stevie Taylor Wren Ash Arden Ainsley Ellery Emery
      Hollis Jody Kit Laurie Marlowe Merritt Oakley Perry Remy Sage Shiloh Teagan Tatum Finley
    `,
  },

  romance: {
    female: `
      Adele Agathe Amelie Anais Aurelie Brigitte Capucine Celine Chantal Claire Colette Delphine
      Elodie Emilie Estelle Fleur Genevieve Helene Ines Josephine Juliette Lea Lisette Lucie
      Madeleine Manon Margaux Margot Marion Mathilde Noemie Oceane Odette Ophelie Romane Sandrine
      Solene Sylvie Veronique Yvette Zoe Alessandra Alessia Arianna Bianca Carla Caterina Chiara
      Elisa Federica Francesca Gemma Giada Ginevra Giorgia Giulia Ilaria Letizia Lucrezia Ludovica
      Marta Martina Nicoletta Ottavia Paola Rosalia Serena Silvia Teresa Viola Vittoria Aitana
      Ainhoa Almudena Amaia Begona Carmen Cristina Irene Leire Macarena Montserrat Nerea Nuria
      Pilar Leonor Mafalda Matilde Rita Laia Mireia Ioana Andreea Ileana Oana Raluca Simona
      Eugenie Berenice Clotilde Marguerite Rosalie Benedetta Costanza Donatella Isotta
    `,
    male: `
      Adrien Alain Antoine Arnaud Aurelien Bastien Benoit Clement Cyril Damien Etienne Fabien
      Florian Francois Gaspard Gaetan Guillaume Jacques Jean Jerome Julien Laurent Loic Lucien
      Marcel Mathieu Nicolas Olivier Pascal Philippe Pierre Quentin Raphael Remi Romain Sebastien
      Thibault Valentin Xavier Yann Yves Alessandro Angelo Antonio Bruno Carlo Cesare Dario Davide
      Emanuele Enzo Fabio Filippo Franco Gianluca Giacomo Giorgio Giovanni Giuseppe Leonardo
      Lorenzo Luca Marco Massimo Matteo Mattia Michele Niccolo Paolo Pietro Riccardo Roberto
      Salvatore Sandro Stefano Tommaso Umberto Vincenzo Vittorio Alvaro Aitor Borja Iker Inigo
      Jaime Jordi Mikel Oriol Unai Xavi Afonso Duarte Goncalo Tiago Vasco Andrei Dragos Florin
      Ionut Mihai Radu Sorin Tudor Marc Pol Arnau Baptiste Corentin Gauthier Achille Ettore Noe
      Elia
    `,
    unisex: `
      Camille Dominique Claude Andrea Alix Lou Ange Simone Nicola Celeste Fiore Sacha Swann Gabi
      Eden Loan Ariel
    `,
  },

  'fantasy-invented': {
    female: `
      Aelith Aerin Alyndra Amarel Anwyth Arinel Belisande Caelira Calindra Cirelle Dawnaya Elanwe
      Elowyn Elspira Eryndel Evaine Faelyn Fennira Halcyra Iliandra Isolwen Ithirelle Jessamyr
      Kaelith Kirathe Lisavel Lyssandre Maerith Myrelle Naeris Nimrahel Pellandra Quillara Raelith
      Saelis Sereth Sylvaine Taliesse Ulyra Vaelora Velisse Wynnara Xyrelle Zephyrine Aurenne
      Brisael Cyrelle Dellith Eilowen Feyra Ghislane Hesperine Ilsabeth Jorahne Kessaly Liriande
      Maelis Nerith Oriyel Pherelle Rhovanna Selivay Thessaly Undine Vashtiel Wyndrel Yllaria
      Zaressa Amaethel Briellen Coralis Daelyra Enwyth Fiorelle Galithra Halwen Ishara Jhessal
      Kyrene Lumeria Mirabeth Nyssara Oleandre Pyrenne Rosalith Sarethi Tamsyne Valenwe Xanthe
      Ysolde Zinnara Aveline Celandra Elsabeth Ilyria Lunaria Meliora Seraphel Thalira Veyra
      Winterra Aeloria Brynneth Caerith Driselle Emberly Ophira
    `,
    male: `
      Aldric Arandor Baelin Belthor Caedric Corvane Darrowen Eldrin Faelan Fendric Galvarin
      Halvarre Haldor Ithric Kaedrin Kestor Lorcan Lucavan Maelor Marrick Naveth Norvane Orrin
      Osric Peregrine Quarion Raedan Sarrow Sevrin Taeral Thandric Ulric Velkar Wendric Wystan
      Xandor Zarekh Bastor Calder Corrin Davor Drevan Faramund Gavric Hollin Ilvar Jorund Malvric
      Nerevan Oberic Pellan Quillon Rendell Theron Uthric Valdren Wolfram Yvain Zephram Ardenne
      Brannoc Castellan Dorran Edric Fenwick Gideric Isembard Joren Korvain Lorrik Mordane Odran
      Pyrrhus Ravick Stellan Torin Ulfar Wrenlow Ysander Zoltren Alastor Belrand Corwyn Duskan
    `,
    unisex: `
      Ashen Briar Ember Fen Lark Rook Sable Vesper Kestrel Nyx Oren Quell Rhune Sorrel Talis
      Thorne Vale Zephyr Lumen Aerys Cael Dune Echo Fable Halcyon Indigo Juniper Kairo Lior Moss
      Nimbus Onyx Perrin Reverie Sirin Tamsin Umber Wisp Yarrow Zenith Auris Cirro Elio Faen Isle
      Jory Kip Linnet Merrow
    `,
  },
};
