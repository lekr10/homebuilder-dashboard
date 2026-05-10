exports.handler = async (event) => {
  if (event.headers['x-refresh-token'] !== process.env.REFRESH_TOKEN) {
    return { statusCode: 401 };
  }
  return { statusCode: 200 };
};
