// Netlify Serverless Function: lightning strokes of the last few minutes from ILDN (Indian Lightning Detection Network,
// Centre for Lightning and Thunderstorm Studies, Tripura University, ildn.in).
//
// Their terms: free for non-commercial use, with attribution, and the data must not be modified. The bytes are passed through untouched.
// A plain Netlify rewrite to ildn.in did not work (every path answered with the app's own page), so the server fetches it here. The answer
// is kept at the edge for ten seconds, so ILDN is asked about every ten seconds in all, however many people look.

exports.handler = async function (event) {
  const params = new URLSearchParams(event.rawQuery || '');
  // only the one file the page's own map reads, and only a short window
  const span = Math.min(Math.max(parseInt(params.get('span') || '15', 10) || 15, 1), 15);
  const target = `https://ildn.in/imap-data.php?ut=latest&span=${span}`;

  try {
    const response = await fetch(target, {
      headers: {
        'User-Agent': 'AtmosIQ-personal (non-commercial; lightning of the last minutes; see atmosradar.netlify.app)',
        Accept: '*/*'
      }
    });
    if (!response.ok) {
      return { statusCode: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: `ILDN answered ${response.status}` }) };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=5',
        'Netlify-CDN-Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30'
      },
      body: bytes.toString('base64')
    };
  } catch (e) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: String(e) }) };
  }
};
