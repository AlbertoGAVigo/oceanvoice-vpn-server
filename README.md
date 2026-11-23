# OceanVoice OpenVPN Server

Servidor OpenVPN Community para Docker Engine en Linux. El destino es el entorno
`docker-36net` de Portainer. El despliegue inicial instala el servidor y prepara
su PKI. El alta de clientes y las rutas de las sedes se configuran por separado.

## Despliegue

1. Comprueba que el host tiene `/dev/net/tun`, que el puerto UDP elegido esta
   libre y que la subred `10.80.0.0/24` no se solapa con las redes existentes.
2. En Portainer, abre `docker-36net` y crea el stack `oceanvoice-vpn-server`
   con metodo **Repository**. Usa
   `https://github.com/AlbertoGAVigo/oceanvoice-vpn-server.git`, la referencia
   `refs/heads/main` y el archivo `compose.yaml`. Si el repo es privado,
   introduce en Portainer una credencial de solo lectura para ese repositorio.
3. El puerto publicado es `1194/udp`. Si necesitas otro puerto externo en el
   host, configura `OPENVPN_PORT` en las variables del stack. OpenVPN sigue
   escuchando en el puerto 1194 dentro del contenedor.
4. Tras desplegar, revisa que el servicio este en ejecucion y que sus logs
   incluyan `Initialization Sequence Completed`. Comprueba el acceso desde
   Internet con un cliente autorizado cuando este disponible.

## Actualizaciones y estado

Si cambias el Dockerfile o un archivo que se copia a la imagen, incrementa la
etiqueta local de la imagen en compose.yaml para construir la nueva version.
Revisa los cambios en Git y usa **Pull and redeploy** desde el stack en Portainer.
Comprueba los logs despues de cada actualizacion. Conserva el volumen
`oceanvoice-openvpn-pki` en los redeploys. Contiene la CA y las claves privadas,
la CRL y las asignaciones de IP. Haz copias protegidas de ese volumen y limita
el acceso a los administradores del host. La CA se inicializa sin contrasena para
permitir la puesta en marcha del contenedor sin interaccion.

Renueva la CRL antes de que expire. Puedes regenerarla en el contenedor con
`EASYRSA_PKI=/var/lib/openvpn/pki /usr/share/easy-rsa/easyrsa --batch gen-crl`
y comprobar que sea legible por el proceso de OpenVPN.
