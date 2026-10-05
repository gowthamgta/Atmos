// Netlify Serverless Function: IMD Doppler Weather Radar Proxy
// Eliminates CORS restrictions and geo-blocking by fetching server-side with browser headers

exports.handler = async function (event, context) {
  // Extract requested radar file (e.g. caz_kkl.gif, caz_plk.gif)
  const file =
    event.queryStringParameters?.file ||
    event.path.split('/').filter(Boolean).pop();

  if (!file) {
    return {
      statusCode: 400,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: 'Missing radar file parameter' })
    };
  }

  // Security check: restrict to valid alphanumeric radar image filenames and subpaths
  if (file.includes('..') || !/^[a-zA-Z0-9_\-\.\/]+\.(gif|png|jpg|jpeg)$/i.test(file)) {
    return {
      statusCode: 400,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: 'Invalid file parameter' })
    };
  }

  const targetUrl = `https://mausam.imd.gov.in/Radar/${file}`;

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: 'https://mausam.imd.gov.in/'
      }
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: `Upstream IMD radar server returned HTTP ${response.status}`
        })
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/gif',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Cache-Control': 'public, max-age=60, s-maxage=60'
      },
      body: base64,
      isBase64Encoded: true
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: err.message || 'Failed to proxy IMD radar image'
      })
    };
  }
};
