const baseUrl = 'https://api.qishui.com'

const fixed = {
  aid: '386088',
  app_name: 'luna_pc',
  passport_jssdk_version: '2.4.13',
  passport_jssdk_type: 'normal',
  is_from_ttaccountsdk: '1',
  next: 'https://api.qishui.com',
  need_logo: 'false',
  need_short_url: 'false',
  is_frontier: 'true',
  is_new_login: '1',
  region: 'cn',
  geo_region: 'cn',
  os_region: 'cn',
  sim_region: '',
  iid: '27960026095955',
  version_name: '3.7.0',
  version_code: '30070000',
  channel: 'official',
  build_mode: 'master',
  ac: 'wifi',
  tz_name: 'Asia/Shanghai',
  device_platform: 'windows',
  device_type: 'Windows',
}

function getPcQuery(overrides = {}) {
  return {
    aid: fixed.aid,
    app_name: fixed.app_name,
    region: fixed.region,
    geo_region: fixed.geo_region,
    os_region: fixed.os_region,
    sim_region: fixed.sim_region,
    iid: fixed.iid,
    version_name: fixed.version_name,
    version_code: fixed.version_code,
    channel: fixed.channel,
    build_mode: fixed.build_mode,
    ac: fixed.ac,
    tz_name: fixed.tz_name,
    device_platform: fixed.device_platform,
    device_type: fixed.device_type,
    ...overrides,
  }
}

module.exports = {
  baseUrl,
  fixed,
  getPcQuery,
  endpoints: {
    getQrcode: `${baseUrl}/passport/web/get_qrcode/`,
    checkQrConnect: `${baseUrl}/passport/web/check_qrconnect/`,
    me: `${baseUrl}/luna/pc/me`,
    mePlaylists: `${baseUrl}/luna/pc/me/playlist`,
    meCollectionMixed: `${baseUrl}/luna/pc/me/collection/mixed`,
    playlistDetail: `${baseUrl}/luna/pc/playlist/detail`,
    trackV2: `${baseUrl}/luna/pc/track_v2`,
    videoV2: `${baseUrl}/luna/pc/video_v2`,
  },
}
