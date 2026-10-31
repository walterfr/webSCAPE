# webSCAPE

Navegador experimental para TVs LG com webOS 5.6.2 e Chromium 68. O projeto combina uma interface controlada pelo Magic Remote com um serviço local que reescreve páginas e transpila parte do JavaScript e CSS para o navegador da TV.

## Estado

MVP em validação. O build e o empacotamento estão automatizados, mas cada versão precisa ser conferida na TV. A camada de compatibilidade cobre recursos selecionados; não garante que todo site moderno funcione.

## Desenvolvimento

Requisitos: Node.js e npm no computador, além do CLI webOS TV SDK (`ares-*`).

```powershell
npm ci
npm test
npm run build
npm run package
```

`npm test` executa verificações unitárias do transpiler, polyfills, reescrita de páginas e rotas usadas pelo YouTube. O build gera os diretórios em `dist/`; `npm run package` também cria o `.ipk`.

## Instalação em TV

Ative Developer Mode na TV, configure-a uma vez no webOS TV CLI e mantenha a TV e o computador na mesma rede. Não salve a passphrase no repositório.

```powershell
ares-setup-device --list
ares-install --device <perfil-da-tv> dist/<arquivo-gerado>.ipk
ares-launch --device <perfil-da-tv> com.webscape.app
```

Para observar falhas do serviço durante a validação:

```powershell
ares-log --device <perfil-da-tv> -f
```

## Segurança e compatibilidade

- O proxy aceita apenas HTTP/HTTPS e bloqueia endereços IP locais, privados, reservados e nomes locais; cada redirecionamento passa pela mesma checagem.
- Endereços DNS são resolvidos e fixados à conexão para evitar que uma segunda resolução troque um destino público por um endereço local.
- Certificados TLS agora são validados. Sites com cadeia incompatível com certificados instalados no firmware podem falhar; não desative a validação para contornar esse erro.
- Cada origem web recebe um host `*.localhost` próprio. Chromium precisa resolver esses hosts para loopback; confirme esse comportamento na TV antes de considerar navegação aprovada.
- Cookies são enviados em navegações de documento e para subrecursos da mesma origem. Subrecursos de outra origem não recebem cookies.
- Controles do serviço exigem token aleatório entregue pelo Luna Bus à interface do navegador. O token não é persistido.
- O transpiler não implementa um navegador moderno inteiro. APIs que faltam no Chromium 68 e recursos CSS/JS fora das conversões existentes continuam sendo limitações.

## Validação manual na TV

Registre modelo da TV, data, site e resultado. Não considere instalação bem-sucedida como compatibilidade aprovada.

1. Instalar e abrir app; confirmar que serviço aparece ativo.
2. Abrir um site HTTPS e confirmar que não há erro de certificado.
3. Navegar para outro domínio; confirmar carregamento, login e retorno.
4. Testar busca e reprodução do YouTube, vídeo HLS/MP4, Magic Remote e abas.
5. Conferir logs por erros de DNS para `*.localhost`, timeout, certificado e falta de memória.
6. Confirmar que alternar AdBlock e User-Agent funciona e que a aba continua navegável.
