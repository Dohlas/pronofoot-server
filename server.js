const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ─── ROUTE : Scrape 365scores.com ─────────────────────────────────────────
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url || (!url.includes('365scores') && !url.includes('score365'))) {
    return res.status(400).json({ error: 'URL invalide. Utilise un lien de 365scores.com' });
  }

  try {
    // 365scores.com utilise React/SPA - on essaie d'abord la page normale
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Referer': 'https://www.365scores.com/',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
      },
      timeout: 20000
    });

    const $ = cheerio.load(html);
    const matchData = { sourceUrl: url };

    // ── Extraire les infos depuis l'URL (très fiable pour 365scores) ──
    // Ex: /fr/football/match/bundesliga-25/hamburger-sv-rb-leipzig-...
    const urlParts = url.split('/');
    const matchSlug = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2] || '';
    const leagueSlug = urlParts.find(p => p.includes('-')) || '';

    // Extraire équipes depuis le slug de l'URL
    if (matchSlug && matchSlug.includes('-vs-')) {
      const parts = matchSlug.split('-vs-');
      matchData.team1 = parts[0].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      matchData.team2 = parts[1]?.split('-')[0]?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || '';
    }

    // Extraire ligue depuis l'URL
    const leagueMatch = url.match(/\/football\/match\/([^/]+)\//);
    if (leagueMatch) {
      matchData.league = leagueMatch[1].replace(/-\d+$/, '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    }

    // ── Scraping HTML classique ──
    // Équipes
    const team1Html = $('[class*="competitor-name"]:first, [class*="team-name"]:first, [class*="home-team"]:first, h1').first().text().trim();
    const team2Html = $('[class*="competitor-name"]:last, [class*="team-name"]:last, [class*="away-team"]:last').last().text().trim();
    if (team1Html && !matchData.team1) matchData.team1 = team1Html;
    if (team2Html && !matchData.team2) matchData.team2 = team2Html;

    // Date
    matchData.date = $('[class*="date"], [class*="time"], time').first().text().trim();

    // Score
    matchData.score = $('[class*="score"]').first().text().trim();

    // ── Texte brut complet (le plus important pour l'IA) ──
    $('script, style, nav, footer, [class*="ad"], [class*="banner"], [class*="cookie"]').remove();
    const rawText = $('body').text().replace(/\s+/g, ' ').trim();
    matchData.rawText = rawText.slice(0, 10000);

    // ── Extraction intelligente depuis le texte brut ──
    const injuryKeywords = ['blessé', 'absent', 'suspendu', 'doute', 'indisponible', 'injured', 'suspended', 'doubt', 'miss'];
    const lines = rawText.split(/[.|\n]/).map(l => l.trim()).filter(l => l.length > 5 && l.length < 300);

    const injuries = lines.filter(l => injuryKeywords.some(k => l.toLowerCase().includes(k)));
    matchData.injuries = [...new Set(injuries)].slice(0, 15);

    const formKeywords = ['victoire', 'défaite', 'nul', 'win', 'loss', 'draw', 'derniers matchs', 'forme'];
    const recentMatches = lines.filter(l => formKeywords.some(k => l.toLowerCase().includes(k)));
    matchData.recentMatches = [...new Set(recentMatches)].slice(0, 15);

    const h2hKeywords = ['confrontation', 'face à face', 'h2h', 'head to head', 'historique'];
    const h2h = lines.filter(l => h2hKeywords.some(k => l.toLowerCase().includes(k)));
    matchData.h2h = [...new Set(h2h)].slice(0, 10);

    // Vérification
    if (!matchData.team1 && rawText.length < 200) {
      return res.status(404).json({ error: '365scores.com utilise JavaScript dynamique. Les données de base ont été extraites depuis l\'URL.' });
    }

    // Si pas d'équipes depuis HTML mais URL slug disponible
    if (!matchData.team1 && matchSlug) {
      const slugParts = matchSlug.split('-');
      matchData.team1 = slugParts.slice(0, 2).join(' ');
      matchData.team2 = slugParts.slice(2, 4).join(' ');
    }

    res.json({ success: true, data: matchData });

  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ error: `Erreur: ${err.message}` });
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
