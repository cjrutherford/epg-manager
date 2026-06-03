const parser = require('iptv-playlist-parser');
const axios = require('axios');
axios.get('https://iptv-org.github.io/iptv/countries/ad.m3u').then(res => {
    const list = parser.parse(res.data);
    console.log(list.items[0]);
});
