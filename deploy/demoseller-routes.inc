client_max_body_size 10m;
limit_req zone=griipbuddy_dev_marketplace_writes burst=90 nodelay;
limit_req_status 429;
add_header X-Robots-Tag "noindex, nofollow" always;
add_header Cache-Control "private, no-store" always;

proxy_http_version 1.1;
proxy_set_header Host demoseller.griipbuddy.com;
proxy_set_header X-Forwarded-Host demoseller.griipbuddy.com;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Griip-Country-Hint $griipbuddy_hybrid_country;
proxy_set_header X-Griip-Current-Market "";
proxy_set_header Authorization "";
proxy_set_header Cookie $http_cookie;
proxy_read_timeout 45s;

if ($griipbuddy_public_method_denied) { return 405; }

location = / { return 302 /seller; }
location ~ ^/(?:admin|staff|api/staff)(?:/|$) { return 404; }

location ~ ^/(?:seller|account|orders|messages|shops|bd/shops|_next|catalog|editorial|identity|media)(?:/|$) {
    proxy_pass http://127.0.0.1:4402;
}
location ~ ^/api/(?:shopper-auth/|marketplace(?:$|/)) {
    proxy_pass http://127.0.0.1:4402;
}
location = /favicon.ico { proxy_pass http://127.0.0.1:4402; }
location / { return 302 https://dev.griipbuddy.com$request_uri; }
