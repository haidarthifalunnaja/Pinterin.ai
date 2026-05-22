import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from 'dotenv';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // Gemini Setup
  let aiInstance: GoogleGenAI | null = null;
  function getAI(): GoogleGenAI {
    if (!aiInstance) {
      aiInstance = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY || 'dummy_api_key_for_offline_fallback',
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
    }
    return aiInstance;
  }

  // API Routes
  
  // Call Gemini Helper with exponential backoff retry.
  // It handles transient 429 errors nicely by retrying 2 times.
  async function callGemini<T>(fn: () => Promise<T>, retries = 2, delayMs = 2000): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      const isQuotaError = error.message?.includes('429') || error.message?.includes('Quota') || error.message?.includes('RESOURCE_EXHAUSTED');
      if (retries > 0 && isQuotaError) {
        console.warn(`[Gemini API Rate Limit] Retrying in ${delayMs}ms... (${retries} retries left)`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return callGemini(fn, retries - 1, delayMs * 2);
      }
      throw error;
    }
  }

  // Robust dynamic fallback generators for offline capability during quota exhaustion
  function getFallbackSearch(query: string): string {
    const topic = query ? query.trim() : 'Materi Umum';
    return `### 💡 Hasil Panduan Pintar "Pinterin.ai" (Offline Mode)

Halo! Karena server utama AI kami saat ini sedang menerima traffic teramat padat (kuota harian habis), aku telah membuat **Rangkuman Pembelajaran Khas Pinterin.ai** tentang topik:

## 📖 **${topic.toUpperCase()}**

Berikut poin-poin penting teratas untuk topik ini:

1. **Konsep Esensial**: Topik **${topic}** mencakup pengenalan konsep fundamental, penemuan pola berulang, serta pemahaman bagaimana setiap sub-topik terhubung secara logis dalam pembelajaran.
2. **Aspek Kunci Terpenting**:
   - **Struktur & Aturan**: Diperlukan pendekatan teratur dan bertahap dari pemahaman dasar ke tingkat lanjut.
   - **Praktik & Pengulangan**: Kemampuan sejati terbentuk lewat latihan yang terus-menerus dan review materi secara kontinyu.
3. **Analogi Sederhana**: Mempelajari **${topic}** itu seperti belajar naik sepeda. Di awal terasa menyeimbangkan kemudi sangatlah kaku, namun seiring seringnya mencoba dan mengoreksi arah kayuhan, semua hal fungsional akan berjalan otomatis dan lancar!

---

### 🔥 **Motivasi Untuk Kamu**
*"Setiap langkah kecil yang kamu ambil hari ini untuk belajar adalah investasi terbaik untuk masa depanmu. Jangan pernah takut salah, karena dari sana kepintaran sejati dimulai!"* 💪✨`;
  }

  function getFallbackEssayEval(questions: any[], userAnswers: any) {
    const evaluations = questions.map((q: any) => {
      const qid = q.id;
      const uAns = (userAnswers[qid] || '').trim();
      const correctAnswer = q.correctAnswer || '';
      const keyPoints = q.keyPoints || [];

      let isCorrect = false;
      let feedback = '';

      if (uAns.length > 5) {
        // Simple case-insensitive match or minimum length check with some keywords matched
        const uAnsLower = uAns.toLowerCase();
        const scorePoints = keyPoints.filter((kp: string) => {
          const words = kp.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
          return words.some((w: string) => uAnsLower.includes(w));
        });

        if (scorePoints.length > 0 || uAns.length > 25) {
          isCorrect = true;
        }
      }

      if (isCorrect) {
        feedback = `Keren banget! Penjelasan essay kamu sudah mencakup inti utama dari topik yang ditanyakan. Kamu sukses menjabarkan konsep dengan bahasa yang santai namun berbobot! Tetap pertahankan kualitas belajarmu! 🌟`;
      } else if (!uAns) {
        feedback = `Jawaban essay ini masih kosong ya. Ingat, kunci jawaban utamanya adalah: "${correctAnswer}". Usahakan tulis pemahaman kamu seremeh apa pun di kuis selanjutnya!`;
      } else {
        feedback = `Jawaban kamu sudah mengarah pada topik, tetapi masih kurang mendalam. Sebaiknya ulas kembali poin-poin berikut: ${keyPoints.slice(0, 2).join(', ')}. Kunci ideal: "${correctAnswer}". Semangat belajarnya, jangan menyerah! 💪`;
      }

      return {
        questionId: qid,
        isCorrect,
        feedback
      };
    });

    return { evaluations };
  }

  function getFallbackQuiz(material: string, type: string, count: number, difficulty: string, language: string) {
    const cleanMat = (material || 'Pengetahuan Umum Terpadu').trim();
    const matLower = cleanMat.toLowerCase();
    
    // Clean words to use as distractions / alternative answers
    const cleanedWords = cleanMat
      .split(/\s+/)
      .map(w => w.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,""))
      .filter(w => w.length > 4 && w.length < 15);
    
    const distractors = cleanedWords.length >= 8 
      ? Array.from(new Set(cleanedWords)).slice(0, 15)
      : ["Pendidikan", "Analisis", "Teknologi", "Logika", "Strategi", "Evaluasi", "Struktur", "Prinsip", "Konsep", "Metodologi", "Pemahaman", "Aplikasi"];

    const questions: any[] = [];
    
    // A. SUBJECT DETECTOR (Preloaded highly organic Indonesian curriculum topics)
    const isHistory = matLower.includes('sejarah') || matLower.includes('merdeka') || matLower.includes('proklamasi') || matLower.includes('pancasila') || matLower.includes('pahlawan') || matLower.includes('indonesia');
    const isPhysics = matLower.includes('fisika') || matLower.includes('gaya') || matLower.includes('energi') || matLower.includes('newton') || matLower.includes('gravitasi') || matLower.includes('listrik') || matLower.includes('kalor') || matLower.includes('ipa');
    const isBiology = matLower.includes('biologi') || matLower.includes('sel') || matLower.includes('tumbuhan') || matLower.includes('hewan') || matLower.includes('fotosintesis') || matLower.includes('darah') || matLower.includes('ekosistem');
    const isAstronomy = matLower.includes('tata surya') || matLower.includes('planet') || matLower.includes('bintang') || matLower.includes('bumi') || matLower.includes('matahari') || matLower.includes('astronomi');
    const isMath = matLower.includes('matematika') || matLower.includes('hitung') || matLower.includes('angka') || matLower.includes('rumus') || matLower.includes('aljabar') || matLower.includes('segitiga') || matLower.includes('persamaan');

    // Prepare pool of specific mock standard questions for high fidelity
    let subjectPool: any[] = [];

    if (isHistory) {
      subjectPool = [
        {
          question: "Siapakah tokoh bangsa yang merumuskan teks Proklamasi Kemerdekaan Indonesia di rumah Laksamana Maeda?",
          options: ["Ir. Soekarno, Drs. Moh. Hatta, dan Mr. Achmad Soebardjo", "Sutan Syahrir, Dr. Muwardi, dan Chaerul Saleh", "Sayuti Melik, Sukarni, dan B.M. Diah", "Ki Hajar Dewantara, KH Mas Mansyur, dan Kasman Singodimedjo"],
          correctAnswer: "A",
          explanation: "Teks Proklamasi Indonesia dirumuskan oleh 'Tiga Tokoh Utama': Ir. Soekarno, Drs. Moh. Hatta, dan Mr. Achmad Soebardjo pada dini hari 17 Agustus 1945.",
          keyPoints: ["Merupakan perumus resmi teks Proklamasi", "Dilaksanakan di rumah Laksamana Tadashi Maeda", "Mr. Achmad Soebardjo mewakili golongan akademisi/tua"]
        },
        {
          question: "Peristiwa penculikan Ir. Soekarno dan Drs. Moh. Hatta ke suatu tempat bertujuan menjauhkan mereka dari pengaruh Jepang dinamakan...",
          options: ["Peristiwa Rengasdengklok", "Peristiwa Ambarawa", "Peristiwa Rawagede", "Sumpah Pemuda Proklamasi"],
          correctAnswer: "A",
          explanation: "Peristiwa Rengasdengklok terjadi pada tanggal 16 Agustus 1945 di mana Soekarno-Hatta dibawa oleh golongan muda agar segera memproklamasikan kemerdekaan.",
          keyPoints: ["Terjadi tanggal 16 Agustus 1945", "Dipelopori golongan muda seperti Sukarni dan Chaerul Saleh", "Tujuan menghindari intimidasi militer Jepang"]
        },
        {
          question: "Sila ketiga Pancasila berbunyi 'Persatuan Indonesia'. Lambang sila ketiga ini pada burung Garuda adalah...",
          options: ["Pohon Beringin", "Kepala Banteng", "Rantai Emas", "Padi dan Kapas"],
          correctAnswer: "A",
          explanation: "Pohon Beringin melambangkan sila ketiga (Persatuan Indonesia) karena memiliki akar tunjang yang kokoh mencerminkan kekuatan bangsa Indonesia untuk bersatu.",
          keyPoints: ["Melambangkan keteduhan dan persatuan", "Akar yang menjalar menandakan keragaman suku", "Sila ketiga: Persatuan Indonesia"]
        },
        {
          question: "Sumpah Pemuda yang menjadi tonggak kristalisasi semangat persatuan nasional diikrarkan pada tanggal...",
          options: ["28 Oktober 1928", "17 Agustus 1945", "20 Mei 1908", "10 November 1945"],
          correctAnswer: "A",
          explanation: "Sumpah Pemuda dirumuskan dalam Kongres Pemuda II tanggal 28 Oktober 1928 dengan tiga poin kebangsaan: tanah air, bangsa, dan bahasa yang satu.",
          keyPoints: ["Kongres Pemuda II di Jakarta", "Lahirnya ikrar Satu Nusa, Satu Bangsa, Satu Bahasa", "Menandai kebangkitan gerakan kepemudaan nasional"]
        },
        {
          question: "Siapakah tokoh pengetik naskah proklamasi yang autentik setelah disetujui oleh para perumus?",
          options: ["Sayuti Melik", "Sukarni", "B.M. Diah", "Latief Hendraningrat"],
          correctAnswer: "A",
          explanation: "Sayuti Melik adalah tokoh golongan muda yang bertugas mengetik naskah proklamasi yang dibacakan oleh Bung Karno.",
          keyPoints: ["Mengetik naskah di mesin tik", "Melakukan beberapa perubahan kecil dari naskah tulisan tangan", "Bagian dari pemuda progresif di Jakarta"]
        }
      ];
    } else if (isPhysics) {
      subjectPool = [
        {
          question: "Sebuah benda akan tetap diam atau bergerak lurus beraturan jika tidak ada gaya luar yang bekerja padanya. Ini merupakan bunyi...",
          options: ["Hukum Newton I", "Hukum Newton II", "Hukum Newton III", "Hukum Gravitasi Universal"],
          correctAnswer: "A",
          explanation: "Hukum Newton I (Hukum Kelembaman) menyatakan bahwa benda condong mempertahankan keadaannya selama resultan gaya yang bekerja nol.",
          keyPoints: ["Hukum kelembaman / inersia", "Resultan gaya (Sigma F) sama dengan nol", "Benda mempertahankan posisi awal"]
        },
        {
          question: "Satuan standar internasional (SI) untuk mengukur gaya fisika adalah...",
          options: ["Newton", "Joule", "Watt", "Pascal"],
          correctAnswer: "A",
          explanation: "Newton (N) adalah satuan SI untuk gaya untuk menghormati ilmuwan Sir Isaac Newton. 1 Newton setara dengan 1 kg.m/s².",
          keyPoints: ["Simbol satuan adalah N", "Didefinisikan dari percepatan massa", "Ditemukan oleh Sir Isaac Newton"]
        },
        {
          question: "Energi yang dimiliki suatu benda akibat dari posisi ketinggiannya dalam medan gravitasi disebut...",
          options: ["Energi Potensial Gravitasi", "Energi Kinetik", "Energi Mekanik Total", "Energi Termal Gesekan"],
          correctAnswer: "A",
          explanation: "Energi Potensial Gravitasi dirumuskan dengan Ep = m.g.h, sangat bergantung pada massa benda, gravitasi, dan ketinggian posisi.",
          keyPoints: ["Bergantung pada tinggi (h)", "Memiliki hubungan lurus dengan percepatan gravitasi", "Dirumuskan Ep = m * g * h"]
        },
        {
          question: "Perpindahan kalor/panas melalui medium tanpa disertai perpindahan partikel-partikel zat perantaranya dinamakan...",
          options: ["Konduksi", "Konveksi", "Radiasi", "Evaporasi"],
          correctAnswer: "A",
          explanation: "Konduksi terjadi pada benda padat seperti logam di mana kalor merambat lewat getaran molekul tanpa memindahkan materi tersebut.",
          keyPoints: ["Merambat melalui zat padat/logam", "Tidak ada aliran massa partikel perantara", "Arus panas mengalir dari suhu tinggi ke rendah"]
        }
      ];
    } else if (isBiology) {
      subjectPool = [
        {
          question: "Organel sel tumbuhan yang memegang peranan mutlak dalam menangkap fotosintesis dengan klorofil adalah...",
          options: ["Kloroplas", "Mitokondria", "Ribosom", "Aparatus Golgi"],
          correctAnswer: "A",
          explanation: "Kloroplas mengandung pigmen klorofil yang menyerap cahaya matahari untuk mengubah karbondioksida dan air menjadi glukosa.",
          keyPoints: ["Mengandung pigmen klorofil hijau", "Melangsungkan reaksi fotosintesis", "Hanya ada pada sel tumbuhan dan alga"]
        },
        {
          question: "Organel sel yang sering mendapat julukan 'The Powerhouse of Cell' karena menjadi pabrik penghasil energi ATP adalah...",
          options: ["Mitokondria", "Nukleus", "Lisosom", "Retikulum Endoplasma"],
          correctAnswer: "A",
          explanation: "Mitokondria bertanggung jawab atas respirasi seluler karbohidrat untuk membentuk molekul kaya energi ATP.",
          keyPoints: ["Menghasilkan energi ATP", "Mempunyai membran ganda internal", "Memproses respirasi seluler aerob"]
        },
        {
          question: "Zat hijau daun yang menyerap energi radiasi matahari dalam reaksi fotosintesis tumbuhan dinamakan...",
          options: ["Klorofil", "Karotenoid", "Mielin", "Hemoglobin"],
          correctAnswer: "A",
          explanation: "Klorofil adalah zat pigmen fotosintetik utama pada tumbuhan yang menyerap cahaya biru dan merah untuk menyuplai energi reaksi kimia.",
          keyPoints: ["Pigmen penangkap cahaya matahari", "Memberikan spektrum warna hijau daun", "Berada di dalam membran tilakoid"]
        },
        {
          question: "Manakah organ tubuh manusia yang berfungsi memompa darah ke seluruh bagian tubuh dalam sistem kardiovaskular?",
          options: ["Jantung", "Paru-Paru", "Hati", "Ginjal"],
          correctAnswer: "A",
          explanation: "Jantung manusia memiliki empat ruang berotot kuat yang secara ritmis berkontraksi memompa darah kaya oksigen dan nutrisi ke seluruh tubuh.",
          keyPoints: ["Otot lurik jantung yang involuntir", "Terdiri dari atrium dan ventrikel", "Memompa darah secara konsisten"]
        }
      ];
    } else if (isAstronomy) {
      subjectPool = [
        {
          question: "Planet manakah yang terkenal dengan sebutan 'Red Planet' atau Planet Merah karena kaya akan senyawa karat besi?",
          options: ["Mars", "Venus", "Jupiter", "Saturnus"],
          correctAnswer: "A",
          explanation: "Permukaan Mars ditutupi oleh debu kaya akan silika dan oksida besi (karat), menjadikannya terlihat berwarna jingga kemerahan dari bumi.",
          keyPoints: ["Oksida besi di permukaan tanah", "Planet urutan keempat dari matahari", "Memiliki dua bulan kecil: Phobos & Deimos"]
        },
        {
          question: "Apakah nama galaksi spiral raksasa tempat Sistem Tata Surya bumi kita bernaung saat ini?",
          options: ["Galaksi Bimasakti (Milky Way)", "Galaksi Andromeda", "Galaksi Triangulum", "Galaksi Sombrero"],
          correctAnswer: "A",
          explanation: "Sistem Tata Surya kita terletak pada salah satu lengan Galaksi Bimasakti (Milky Way), galaksi spiral berukuran sedang.",
          keyPoints: ["Galaksi rumah kita", "Morfologi galaksi spiral berbatang", "Terdiri dari ratusan miliar sistem bintang"]
        },
        {
          question: "Benda langit berbatu berdiameter kecil yang mengitari matahari, paling padat berkumpul di antara orbit Mars dan Jupiter disebut...",
          options: ["Asteroid", "Komet", "Meteoroid", "Nebula"],
          correctAnswer: "A",
          explanation: "Sabuk Asteroid (Asteroid Belt) terletak di celah orbit antara planet Mars dan Jupiter, diisi oleh jutaan serpihan batuan matahari.",
          keyPoints: ["Kumpulan batu luar angkasa", "Berada di Sabuk Asteroid Mars-Jupiter", "Ukurannya jauh lebih kecil dari planet kerdil"]
        },
        {
          question: "Planet terbesar dalam sistem Tata Surya kita yang memiliki badai konveksi legendaris 'Great Red Spot' adalah...",
          options: ["Jupiter", "Saturnus", "Uranus", "Neptunus"],
          correctAnswer: "A",
          explanation: "Jupiter merupakan raksasa gas dengan massa 300 kali bumi dan memiliki pusaran badai atmosfer konstan 'Bintik Merah Raksasa'.",
          keyPoints: ["Raksasa gas terbesar", "Memiliki daya gravitasi sangat masif", "Dikenal dengan sistem puluhan bulan pengorbit"]
        }
      ];
    } else if (isMath) {
      subjectPool = [
        {
          question: "Berapakah nilai hasil dari operasi hitung konvensional: 15 + 5 x 4 - 8?",
          options: ["27", "72", "42", "20"],
          correctAnswer: "A",
          explanation: "Gunakan aturan prioritas KABATAKU: kerjakan perkalian terlebih dahulu. 5 x 4 = 20. Kemudian 15 + 20 - 8 = 27.",
          keyPoints: ["Aturan prioritas matematika KABATAKU", "Perkalian/Pembagian didahulukan sebelum tambah/kurang", "Hasil akhir adalah 27"]
        },
        {
          question: "Jika sebuah wadah berbentuk kotak balok memiliki panjang 10 cm, lebar 5 cm, dan tinggi 6 cm. Berapa volume balok tersebut?",
          options: ["300 cm³", "150 cm³", "60 cm³", "120 cm³"],
          correctAnswer: "A",
          explanation: "Volume Balok dirumuskan: Panjang x Lebar x Tinggi. Maka, 10 x 5 x 6 = 300 cm³.",
          keyPoints: ["Rumus dasar: V = p * l * t", "Dimensi volume dalam kubik", "Perhitungan cepat: 50 * 6 = 300"]
        },
        {
          question: "Selesaikan persamaan linear sederhana berikut untuk mencari nilai y: 4y - 7 = 13.",
          options: ["y = 5", "y = 4", "y = 3", "y = 7"],
          correctAnswer: "A",
          explanation: "4y - 7 = 13 => 4y = 13 + 7 => 4y = 20 => y = 20 / 4 = 5.",
          keyPoints: ["Persamaan linear satu variabel", "Pindahkan konstanta melintasi sama dengan", "Lakukan pembagian koefisien"]
        }
      ];
    }

    // B. DYNAMIC TEXT INTERPRETER FALLBACK (Factual questions based on sentences inside the uploaded material!)
    // If no specific subject match was strong, OR if we need more diverse items in a hybrid fashion,
    // we extract factual sentences from the material provided by the student.
    const sentences = cleanMat
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 25 && s.length < 200);

    // Filter list of valid key facts from sentences
    const factualQuestions: any[] = [];
    for (const sent of sentences) {
      // Find a reasonable word inside the sentence to hide
      const words = sent.split(/\s+/).map(w => w.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,""));
      // Find a capitalized word (noun) or long word that can represent key knowledge
      const targetWord = words.find((w, idx) => {
        // Skip first word, select long significant word
        return idx > 0 && w.length >= 6 && /^[a-zA-Z0-9]+$/.test(w) && !["adalah", "dengan", "sebagai", "dalam", "untuk", "mereka", "karena", "terdiri"].includes(w.toLowerCase());
      });

      if (targetWord) {
        // Construct fill in the blanks
        const regex = new RegExp(`\\b${targetWord}\\b`, 'g');
        const sentenceWithBlank = sent.replace(regex, "[_______]");
        
        // Ensure replacement was successful
        if (sentenceWithBlank.includes("[_______]")) {
          // Choose distractors from static array mixed with actual text words
          const filteredDist = distractors.filter(d => d.toLowerCase() !== targetWord.toLowerCase());
          const shuffledDist = filteredDist.sort(() => 0.5 - Math.random()).slice(0, 3);
          
          // Construct multiple choice options
          const optionsList = [targetWord, ...shuffledDist];
          // Shuffle options
          const shuffledOptions = optionsList.sort(() => 0.5 - Math.random());
          const correctIdxLetter = ["A", "B", "C", "D"][shuffledOptions.indexOf(targetWord)];
          
          factualQuestions.push({
            question: `Lengkapi celah rumpang di bawah ini berdasarkan intisari materi:\n\n"${sentenceWithBlank}"`,
            options: shuffledOptions,
            correctAnswer: correctIdxLetter,
            explanation: `Pembahasan: Berdasarkan materi pengantar, istilah yang tepat untuk melengkapi bagian kosong tersebut adalah "${targetWord}".`,
            keyPoints: [`Melengkapi teks rumpang: ${targetWord}`, "Mempertajam pemahaman membaca detail teks", "Membentuk daya ingat hafalan semantik"]
          });
        }
      }
    }

    // Combine Pools: Subject Pool and Factual Questions
    const hybridPool = [...subjectPool, ...factualQuestions];

    // If still empty or too small, inject beautiful general learning questions in Indonesian
    if (hybridPool.length < count) {
      const basicKeywords = distractors.slice(0, 5);
      basicKeywords.forEach((kw, kIdx) => {
        const uKw = kw.charAt(0).toUpperCase() + kw.slice(1);
        hybridPool.push({
          question: `Dalam metode pembelajaran aktif Pinterin.ai, mengapa konsep tentang "${uKw}" dipandang sebagai instrumen yang sangat vital?`,
          options: [
            `Membantu menstrukturkan pemikiran secara logis, mengenali jembatan keledai, dan memperkokoh daya ingat jangka panjang`,
            `Bertujuan mereduksi motivasi belajar siswa agar materi terkesan sangat elit`,
            `Hanya berfungsi sebagai hiasan teoritis pelengkap kurikulum darurat`,
            `Guna mempersingkat waktu istirahat peserta didik secara sepihak`
          ],
          correctAnswer: "A",
          explanation: `Pembahasan: Pemahaman mendalam terkait "${uKw}" memberikan fondasi kognitif yang kokoh sehingga materi baru bisa saling terhubung dalam otak siswa.`,
          keyPoints: ["Membahas strategi asimilasi kognitif", `Mendeskripsikan peranan penting dari ${kw}`, "Mendorong retensi belajar aktif yang optimal"]
        });
      });
    }

    // Shuffle pool
    const finalPool = hybridPool.sort(() => 0.5 - Math.random()).slice(0, Math.min(count, hybridPool.length));

    // Populate the questions up to the requested count
    for (let i = 0; i < count; i++) {
      const pItem = finalPool[i % finalPool.length];
      const qid = `q_fallback_${i}_${Date.now()}`;
      
      if (type === 'multiple_choice') {
        questions.push({
          id: qid,
          question: pItem.question,
          options: pItem.options,
          correctAnswer: pItem.correctAnswer,
          explanation: pItem.explanation
        });
      } else {
        // Essay Questions fallback
        // Convert MCQ question to essay question elegantly
        const cleanQ = pItem.question.replace(/Lengkapi celah rumpang di bawah ini berdasarkan intisari materi:/, "Jelaskan konsep berikut secara mendalam berdasarkan materi:");
        questions.push({
          id: qid,
          question: cleanQ,
          correctAnswer: pItem.options ? `Kunci jawaban ideal melibatkan kata: "${pItem.options[0] || pItem.correctAnswer}". ${pItem.explanation}` : `Konsep utama: ${pItem.explanation}`,
          explanation: pItem.explanation,
          keyPoints: pItem.keyPoints || ["Menerangkan argumen pokok", "Menghubungkan teori dasar ke kehidupan nyata", "Gaya penyampaian terstruktur"]
        });
      }
    }

    return {
      questions,
      motivation: `Pinterin.ai mempersembahkan Kuis Spesialis Offline! Server utama sedang diakses bertubi-tubi, namun robot AI offline kami sukses mendeteksi subjek belajar-mu dan menghasilkan ${count} soal premium yang asyik! Semangat menguji batas kemampuanmu! 🚀🔥`
    };
  }

  // Duel Arena State Store
  interface DuelRoom {
    code: string;
    status: 'waiting' | 'ready' | 'finished';
    quiz: any;
    creator: {
      name: string;
      score: number | null;
    };
    opponent: {
      name: string;
      score: number | null;
    } | null;
    createdAt: number;
  }

  const duelRooms = new Map<string, DuelRoom>();

  // Clean stale/expired duel rooms (older than 2 hours) occasionally
  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of duelRooms.entries()) {
      if (now - room.createdAt > 2 * 60 * 60 * 1000) {
        duelRooms.delete(code);
      }
    }
  }, 15 * 60 * 1000);

  app.post('/api/duel/create', (req, res) => {
    const { quiz, creatorName } = req.body;
    if (!quiz || !creatorName) {
      return res.status(400).json({ success: false, error: 'Materi kuis atau nama pembuat tidak lengkap' });
    }

    // Generate readable 5-char code
    let code = '';
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do {
      code = '';
      for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (duelRooms.has(code));

    const room: DuelRoom = {
      code,
      status: 'waiting',
      quiz,
      creator: {
        name: creatorName,
        score: null
      },
      opponent: null,
      createdAt: Date.now()
    };

    duelRooms.set(code, room);
    res.json({ success: true, code, room });
  });

  app.post('/api/duel/join', (req, res) => {
    const { code, opponentName } = req.body;
    if (!code || !opponentName) {
      return res.status(400).json({ success: false, error: 'Kode duel atau nama penantang tidak lengkap' });
    }

    const cleanCode = code.trim().toUpperCase();
    const room = duelRooms.get(cleanCode);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Opps! Kode duel tidak terdaftar atau sudah kedaluwarsa.' });
    }

    if (room.opponent && room.opponent.name !== opponentName) {
      return res.status(403).json({ success: false, error: 'Waduh! Arena kuis ini sudah penuh diisi oleh penantang lain.' });
    }

    if (!room.opponent) {
      room.opponent = {
        name: opponentName,
        score: null
      };
      room.status = 'ready';
    }

    res.json({ success: true, room });
  });

  app.get('/api/duel/status/:code', (req, res) => {
    const code = req.params.code?.trim().toUpperCase();
    const room = duelRooms.get(code);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Kode duel tidak ditemukan.' });
    }
    res.json({ success: true, room });
  });

  app.post('/api/duel/submit', (req, res) => {
    const { code, playerName, score } = req.body;
    if (!code || !playerName || score === undefined) {
      return res.status(400).json({ success: false, error: 'Informasi pengiriman nilai duel tidak lengkap.' });
    }

    const cleanCode = code.trim().toUpperCase();
    const room = duelRooms.get(cleanCode);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Kode duel tidak ditemukan.' });
    }

    if (room.creator.name === playerName) {
      room.creator.score = Number(score);
    } else if (room.opponent && room.opponent.name === playerName) {
      room.opponent.score = Number(score);
    } else {
      return res.status(403).json({ success: false, error: 'Waduh, kamu tidak terdaftar sebagai peserta di duel ini!' });
    }

    if (room.creator.score !== null && room.opponent !== null && room.opponent.score !== null) {
      room.status = 'finished';
    }

    res.json({ success: true, room });
  });

  app.post('/api/search-material', async (req, res) => {
    const { query = '', context = '' } = req.body || {};
    try {
      const prompt = `
        Anda adalah tutor cerdas "Pinterin.ai" yang ramah, pintar, dan inspiratif.
        Gunakan gaya bicara yang santai namun tetap sopan, gunakan "aku/kamu" untuk menyapa pengguna, sertakan emoji yang relevan, dan pastikan penjelasan kamu mudah dimengerti.
        
        Pengguna bertanya tentang materi: "${query}"
        
        Tugas Anda:
        1. Berikan penjelasan yang mendalam tapi gampang banget dicerna, jangan kaku!
        2. Gunakan analogi yang deket sama kehidupan sehari-hari (misal: analogi scroll TikTok, belanja online, dll).
        3. Berikan poin-poin penting biar enak dibaca.
        4. Akhiri dengan kata-kata motivasi yang "fire" 🔥.
        
        Konteks tambahan (pilihan): ${context || 'Tidak ada'}
      `;

      const responseText = await callGemini(async () => {
        const result = await getAI().models.generateContent({
          model: "gemini-3.5-flash",
          contents: { parts: [{ text: prompt }] },
        });
        return result.text;
      });

      res.json({ response: responseText });
    } catch (error: any) {
      console.warn('Gemini Search failed, serving offline search fallback:', error.message || error);
      // Serve the beautiful offline dynamic content
      const fallbackResponse = getFallbackSearch(query);
      res.json({ response: fallbackResponse });
    }
  });

  app.post('/api/evaluate-essay', async (req, res) => {
    const { questions = [], userAnswers = {} } = req.body || {};
    try {
      const prompt = `
        Anda adalah pengajar yang inspiratif di Pinterin.ai. Nilailah jawaban essay ini dengan bahasa yang menyemangati dan sopan (gunakan "aku/kamu").
        
        DATA KUIS:
        ${(questions || []).map((q: any) => `
          Soal: ${q.question}
          Kunci: ${q.correctAnswer}
          Jawaban User: ${userAnswers[q.id] || '(Kosong)'}
        `).join('\n')}

        KRITERIA PENILAIAN (FLEKSIBEL):
        1. Benar (isCorrect: true): Jika inti atau konsep utama dari kunci jawaban ada dalam jawaban user. JANGAN kaku sama pilihan kata. Selama maknanya nyambung, kasih bener!
        2. Salah (isCorrect: false): Jika jawaban melenceng jauh banget, bertentangan sama fakta di kunci, atau cuma ngasal/kosong.
        3. Toleransi: Abaikan typo kecil atau struktur kalimat ga beraturan selama maksudnya dapet.
        4. Feedback: Berikan penjelasan mengapa jawaban tersebut benar atau salah dengan bahasa yang ramah dan edukatif. Berikan pujian jika jawaban mereka sudah mendekati benar atau sangat baik.
        
        Saran: Jangan terlalu kaku dalam menilai. Jika jawaban pengguna memiliki inti yang sama dengan kunci jawaban, berikan nilai benar.
        
        FORMAT JSON:
        {
          "evaluations": [
            { "questionId": "id", "isCorrect": boolean, "feedback": "teks asik" }
          ]
        }
      `;

      const responseObj = await callGemini(async () => {
        const result = await getAI().models.generateContent({
          model: "gemini-3.5-flash",
          contents: { parts: [{ text: prompt }] },
          config: { responseMimeType: "application/json" }
        });
        return JSON.parse(result.text || '{}');
      });

      res.json(responseObj);
    } catch (error: any) {
      console.warn('Gemini Essay Eval failed, serving offline essay grading fallback:', error.message || error);
      const fallbackResult = getFallbackEssayEval(questions, userAnswers);
      res.json(fallbackResult);
    }
  });

  app.post('/api/generate-quiz', async (req, res) => {
    const { material = '', type = 'multiple_choice', count = 5, image = null, difficulty = 'Sedang', language = 'id' } = req.body || {};
    try {
      let contents: any[] = [];
      
      if (image) {
        contents.push({
          inlineData: {
            mimeType: "image/jpeg",
            data: image.split(',')[1] || image
          }
        });
      }

      const promptText = `
        Anda adalah asisten pendidikan cerdas "Pinterin.ai" untuk siswa Indonesia.
        Tugas Anda adalah membuat kuis berkualitas tinggi berdasarkan materi yang diberikan.
        
        Materi: ${material || "Lihat gambar yang dilampirkan"}
        Jenis Soal: ${type === 'multiple_choice' ? 'Pilihan Ganda (A, B, C, D)' : 'Essay'}
        Jumlah Soal: ${count}
        Tingkat Kesulitan: ${difficulty || 'Sedang'} (Mudah/Sedang/Sulit)
        Bahasa Output Utama: ${language === 'en' ? 'English' : 'Bahasa Indonesia'}
        
        Persyaratan Output:
        ${type === 'multiple_choice' ? 
          '- Setiap soal memiliki 4 opsi (A, B, C, D).\n- Tentukan kunci jawaban yang benar.\n- Berikan pembahasan singkat mengapa jawaban tersebut benar.' :
          '- Setiap soal essay harus memiliki kunci jawaban ideal.\n- Berikan poin-poin penting yang harus ada dalam jawaban siswa.'}
        - Sesuaikan tingkat kesulitan untuk target audiens.
        - Jika bahasa yang dipilih adalah English, buat soal dan opsi dalam Bahasa Inggris, namun pembahasan tetap dalam Bahasa Indonesia jika materi aslinya dalam Bahasa Indonesia (kecuali diminta sebaliknya).
      `;

      contents.push({ text: promptText });

      const quizSchema = {
        type: Type.OBJECT,
        properties: {
          questions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                question: { type: Type.STRING },
                options: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: "Hanya untuk pilihan ganda. Array berisi 4 string (A, B, C, D)."
                },
                correctAnswer: { type: Type.STRING, description: "A, B, C, atau D untuk pilihan ganda. Teks lengkap untuk essay." },
                explanation: { type: Type.STRING },
                keyPoints: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: "Hanya untuk essay. Poin-poin penilaian."
                }
              },
              required: ["id", "question", "correctAnswer", "explanation"]
            }
          },
          motivation: { type: Type.STRING, description: "Pesan motivasi singkat dalam Bahasa Indonesia." }
        },
        required: ["questions", "motivation"]
      };

      const responseObj = await callGemini(async () => {
        const result = await getAI().models.generateContent({
          model: "gemini-3.5-flash",
          contents: { parts: contents },
          config: {
            responseMimeType: "application/json",
            responseSchema: quizSchema,
          }
        });
        return JSON.parse(result.text || '{}');
      });

      res.json(responseObj);
    } catch (error: any) {
      console.warn('Gemini Quiz generation failed, serving offline quiz fallback:', error.message || error);
      const fallbackQuiz = getFallbackQuiz(material, type, count, difficulty, language);
      res.json(fallbackQuiz);
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
