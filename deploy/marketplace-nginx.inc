location ~ ^/marketplace(?:/|$) {
    client_max_body_size 4m;
    limit_req zone=griipbuddy_dev_marketplace_writes burst=90 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:4401;
    proxy_set_header Host dev.griipbuddy.com;
    proxy_set_header X-Forwarded-Host dev.griipbuddy.com;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Authorization "";
    proxy_set_header Cookie $http_cookie;
}
