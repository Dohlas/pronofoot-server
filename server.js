const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ─── ROUTE : Scrape Score365 ───────────────────────────────────────────────
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.includes('score365')) {
    return res.status(400).json({ error: 'URL Score365 invalide' });
  }

  try {
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 15000
    });

    const $ = cheerio.load(html);
    const matchData = {};

    // Équipes
    matchData.team1 = $('.home-team .team-name, .participant-name:first, [class*="home"] [class*="name"]').first().text().trim();
    matchData.team2 = $('.away-team .team-name, .participant-name:last, [class*="away"] [class*="name"]').last().text().trim();

    // Date et heure
    matchData.date = $('.match-date, .game-time, [class*="date"], [class*="time"]').first().text().trim();

    // Compétition / Ligue
    matchData.league = $('.tournament-name, .league-name, [class*="tournament"], [class*="league"]').first().text().trim();

    // Score actuel si match en cours
    matchData.score = $('.score, .current-score, [class*="score"]').first().text().trim();

    // Extraire tout le texte pertinent de la page pour l'IA
    // Joueurs blessés / suspendus
    const injuries = [];
    $('[class*="injur"], [class*="miss"], [class*="doubt"], [class*="absent"]').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 1 && text.length < 200) injuries.push(text);
    });
    matchData.injuries = [...new Set(injuries)].slice(0, 20);

    // Derniers matchs / forme
    const recentMatches = [];
    $('[class*="last-match"], [class*="recent"], [class*="form"], [class*="result"]').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 3 && text.length < 300) recentMatches.push(text);
    });
    matchData.recentMatches = [...new Set(recentMatches)].slice(0, 20);

    // Statistiques H2H
    const h2h = [];
    $('[class*="h2h"], [class*="head-to-head"], [class*="versus"]').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 3 && text.length < 300) h2h.push(text);
    });
    matchData.h2h = [...new Set(h2h)].slice(0, 15);

    // Statistiques générales
    const stats = [];
    $('[class*="stat"], [class*="standing"], [class*="ranking"]').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 3 && text.length < 200) stats.push(text);
    });
    matchData.stats = [...new Set(stats)].slice(0, 20);

    // Extraire le texte brut global (fallback pour ne rien rater)
    // Supprimer scripts et styles
    $('script, style, nav, footer, header, .ad, .ads, [class*="banner"]').remove();
    const rawText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);
    matchData.rawText = rawText;

    // Vérification minimale
    if (!matchData.team1 && !matchData.team2 && rawText.length < 100) {
      return res.status(404).json({ error: 'Impossible de lire la page Score365. Le site a peut-être changé sa structure.' });
    }

    res.json({ success: true, data: matchData });

  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ error: `Erreur lors de la récupération: ${err.message}` });
  }
});

// ─── ROUTE : Analyser avec Gemini ─────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { matchData, apiKey } = req.body;

  if (!apiKey) return res.status(400).json({ error: 'Clé API manquante' });
  if (!matchData) return res.status(400).json({ error: 'Données du match manquantes' });

  const prompt = `Tu es un expert en analyse de football avec accès aux données en temps réel du match.

Voici les données récupérées depuis Score365 pour ce match :

ÉQUIPE 1: ${matchData.team1 || 'Inconnue'}
ÉQUIPE 2: ${matchData.team2 || 'Inconnue'}
COMPÉTITION: ${matchData.league || 'Inconnue'}
DATE: ${matchData.date || 'Inconnue'}

BLESSÉS / ABSENTS:
${matchData.injuries?.join('\n') || 'Non disponible'}

MATCHS RÉCENTS / FORME:
${matchData.recentMatches?.join('\n') || 'Non disponible'}

CONFRONTATIONS DIRECTES (H2H):
${matchData.h2h?.join('\n') || 'Non disponible'}

STATISTIQUES:
${matchData.stats?.join('\n') || 'Non disponible'}

DONNÉES BRUTES DE LA PAGE:
${matchData.rawText?.slice(0, 5000) || 'Non disponible'}

---

En te basant UNIQUEMENT sur ces données réelles, fournis une analyse complète et précise.

Réponds UNIQUEMENT en JSON valide avec cette structure:
{
  "team1": "Nom équipe domicile",
  "team2": "Nom équipe extérieur",
  "league": "Compétition",
  "date": "Date du match",
  "predicted_score1": 2,
  "predicted_score2": 1,
  "win_prob_home": 55,
  "win_prob_draw": 25,
  "win_prob_away": 20,
  "confidence": "haute",
  "analysis": "Analyse détaillée en 4-5 phrases basée sur les vraies données: forme récente, blessés importants, historique des confrontations, forces et faiblesses actuelles.",
  "key_factors": ["facteur clé 1 basé sur les données", "facteur clé 2", "facteur clé 3", "facteur clé 4"],
  "probable_events": {
    "first_goal_team": "Équipe la plus susceptible de marquer en premier",
    "both_teams_score": true,
    "over_2_5_goals": true,
    "corners_estimate": "10-12",
    "cards_estimate": "3-4",
    "halftime_score": "1-0"
  },
  "key_players_to_watch": ["Joueur 1 (raison)", "Joueur 2 (raison)"],
  "injuries_impact": "Impact des absences sur le match en 1-2 phrases",
  "betting_tips": ["Conseil 1", "Conseil 2", "Conseil 3"]
}

Les probabilités doivent totaliser 100. Sois précis et base-toi strictement sur les données fournies.`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2000 }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const rawText = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = rawText.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    res.json({ success: true, result });

  } catch (err) {
    console.error('Gemini error:', err.message);
    if (err.response?.status === 403) {
      res.status(403).json({ error: 'Clé API Gemini invalide ou quota dépassé' });
    } else {
      res.status(500).json({ error: `Erreur analyse IA: ${err.message}` });
    }
  }
});

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', message: 'PronoFoot Server running' }));

app.listen(PORT, () => console.log(`✅ PronoFoot Server démarré sur le port ${PORT}`));
