#!/bin/bash -xe
echo "Starting user_data.sh and installing dependencies"

set -euxo pipefail

sudo apt-get update
sudo apt install software-properties-common -y
sudo add-apt-repository ppa:deadsnakes/ppa -y
sudo apt install wget git python3.10 python3.10-venv build-essential net-tools libgl1 libtcmalloc-minimal4 -y
sudo update-alternatives --install /usr/bin/python3 python /usr/bin/python3.10 1

# install s3 fuse
sudo apt install s3fs -y
# Fetch the credentials from the instance metadata service
CREDENTIALS=$(curl http://169.254.169.254/latest/meta-data/iam/security-credentials/sd-ec2-role)

# Parse the AccessKeyId and SecretAccessKey from the JSON
ACCESS_KEY_ID=$(echo $CREDENTIALS | grep -o '"AccessKeyId" : "[^"]*' | grep -o '[^"]*$')
SECRET_ACCESS_KEY=$(echo $CREDENTIALS | grep -o '"SecretAccessKey" : "[^"]*' | grep -o '[^"]*$')

# Store them in the .passwd-s3fs file
echo "$ACCESS_KEY_ID:$SECRET_ACCESS_KEY" > ${HOME}/.passwd-s3fs
chmod 600 ${HOME}/.passwd-s3fs

# s3fs mybucket /path/to/mountpoint -o passwd_file=${HOME}/.passwd-s3fs -o dbglevel=info -f -o curldbg

cd /home/ubuntu

curl -sSL https://raw.githubusercontent.com/awslabs/stable-diffusion-aws-extension/main/install.sh | bash

cd stable-diffusion-webui/extensions/stable-diffusion-aws-extension
git checkout main
cd ../../

wget -qP models/Stable-diffusion/ https://aws-gcr-solutions-us-east-1.s3.us-east-1.amazonaws.com/extension-for-stable-diffusion-on-aws/models/Stable-diffusion/sd_xl_base_1.0.safetensors
wget -qP models/Stable-diffusion/ https://aws-gcr-solutions-us-east-1.s3.us-east-1.amazonaws.com/extension-for-stable-diffusion-on-aws/models/Stable-diffusion/v1-5-pruned-emaonly.safetensors
wget -qP models/ControlNet/ https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11p_sd15_canny.pth
wget -qP models/ControlNet/ https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11p_sd15_openpose.pth
wget -qP models/Lora/ https://aws-gcr-solutions-us-east-1.s3.us-east-1.amazonaws.com/extension-for-stable-diffusion-on-aws/models/Lora/lcm_lora_xl.safetensors
wget -qP models/Lora/ https://aws-gcr-solutions-us-east-1.s3.us-east-1.amazonaws.com/extension-for-stable-diffusion-on-aws/models/Lora/lcm_lora_1_5.safetensors

sudo chown -R ubuntu:ubuntu /home/ubuntu/stable-diffusion-webui

cat > sd-webui.service <<EOF
[Unit]
Description=Stable Diffusion UI server
After=network.target
StartLimitIntervalSec=0

[Service]
WorkingDirectory=/home/ubuntu/stable-diffusion-webui
ExecStart=/home/ubuntu/stable-diffusion-webui/webui.sh --enable-insecure-extension-access --skip-torch-cuda-test --no-half --listen
Type=simple
Restart=always
RestartSec=3
User=ubuntu
StartLimitAction=reboot

[Install]
WantedBy=default.target

EOF
sudo mv sd-webui.service /etc/systemd/system
sudo chown root:root /etc/systemd/system/sd-webui.service

sudo systemctl enable sd-webui.service
sudo systemctl start sd-webui.service