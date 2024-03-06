#!/bin/bash -xe
echo "Starting user_data.sh and installing dependencies"

# set -euxo pipefail
# remove u option since we need the string replacement to work in the following line
set -exo pipefail

sudo apt-get update
sudo apt install software-properties-common -y
sudo add-apt-repository ppa:deadsnakes/ppa -y
sudo apt install wget git python3.10 python3.10-venv build-essential net-tools libgl1 libtcmalloc-minimal4 -y
sudo update-alternatives --install /usr/bin/python3 python /usr/bin/python3.10 1

: <<'COMMENTS'
Function to attach EFS to the instance
COMMENTS

# install s3 fuse
sudo apt install s3fs -y
# Fetch the credentials from the instance metadata service
CREDENTIALS=$(curl http://169.254.169.254/latest/meta-data/iam/security-credentials/sd-ec2-role)
# Fetch the region from the instance metadata service
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)

# Parse the AccessKeyId and SecretAccessKey from the JSON
ACCESS_KEY_ID=$(echo $CREDENTIALS | grep -o '"AccessKeyId" : "[^"]*' | grep -o '[^"]*$')
SECRET_ACCESS_KEY=$(echo $CREDENTIALS | grep -o '"SecretAccessKey" : "[^"]*' | grep -o '[^"]*$')

# Store them in the .passwd-s3fs file
TMP_FOLDER=/tmp
echo "$ACCESS_KEY_ID:$SECRET_ACCESS_KEY" > /tmp/.passwd-s3fs
chmod 600 ${TMP_FOLDER}/.passwd-s3fs
sudo chown ubuntu:ubuntu ${TMP_FOLDER}/.passwd-s3fs

# Fix the foler name to /tmp/s3-mount and /tmp/efs-mount
sudo mkdir -p /tmp/s3-mount
sudo chown ubuntu:ubuntu /tmp/s3-mount

sudo mkdir -p /tmp/efs-mount
sudo chown ubuntu:ubuntu /tmp/efs-mount

# Such placeholders should be replaced by the actual values outside of the script in ec2-stack.ts
BUCKET_NAME="placeholder"
FS_ID="placeholder"

s3fs ${BUCKET_NAME} /tmp/s3-mount -o passwd_file=${TMP_FOLDER}/.passwd-s3fs & > ${TMP_FOLDER}/s3fs.log
echo "S3 bucket ${BUCKET_NAME} mounted at /tmp/s3-mount"

sudo mount -t nfs4 -o nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport ${FS_ID}.efs.${REGION}.amazonaws.com:/ /tmp/efs-mount
echo "EFS file system ${FS_ID} mounted at /tmp/efs-mount"

: <<'COMMENTS'
Function to install the stable diffusion webui and start the service
COMMENTS

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

: <<'COMMENTS'
Create a script named shutdown-script.sh and include the necessary commands to perform the cleanup tasks. TODO: This can be replaced by the lifecycle hook in the Auto Scaling Group, more prototype needed though.
COMMENTS

cat > shutdown-script.sh <<EOF
#!/bin/bash

# Log file
LOG_FILE="/var/log/ec2-shutdown.log"

# Instance metadata service URL
INSTANCE_METADATA_URL="http://169.254.169.254/latest/meta-data"

# Log the date and time of shutdown
echo "Shutdown script started at $(date)" | tee -a $LOG_FILE

# Query instance metadata for lifecycle action, refer to https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html
LIFECYCLE_ACTION=$(curl -s "$INSTANCE_METADATA_URL/spot/instance-action" | jq -r .action)

if [ "$LIFECYCLE_ACTION" = "stop" ] || [ "$LIFECYCLE_ACTION" = "terminate" ]; then
  echo "Instance is being $LIFECYCLE_ACTION due to a rebalance recommendation." | tee -a $LOG_FILE
  # TODO, (1) cleanup tasks here for on-going sd inference jobs; (2) record inference logs to S3; (3) unmount EFS if necessary
else
  echo "Instance is being shut down for another reason." | tee -a $LOG_FILE
fi

# Log the completion of the script
echo "Shutdown script finished at $(date)" | tee -a $LOG_FILE
EOF

: <<'COMMENTS'
TODO, collecting GPU Utilization Data and publish such metric to CloudWatch
COMMENTS

# Configure the AWS credentials
aws configure set aws_access_key_id $ACCESS_KEY_ID
aws configure set aws_secret_access_key $SECRET_ACCESS_KEY
aws configure set default.region ${REGION}

# Create the GPU monitoring script, note we choose to use CloudWatch custom metric instead of offcial AWS CloudWatch Agent for simplicity and flexibility, refer to https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-NVIDIA-GPU.html. Note there are still some specific metrics and features that the CloudWatch Agent may not support compared to what can be obtained through custom scripts using tools like nvidia-smi. Here are some additional metrics and features that you might be able to capture with a custom script, e.g.
- ECC (Error Correcting Code) Errors: Information about ECC error counts, both volatile and aggregate, if the GPU supports ECC.
- GPU Process Information: Details on the processes currently using the GPU, including process name, ID, and memory usage.
- Performance State: The current performance state for the GPU, which can indicate whether the GPU is running at its base clock, memory clock, etc.
- Memory Details: More granular details about memory usage, such as per-process memory usage, or error counts in memory sectors.

cat <<'EOF' >/opt/gpu-monitoring.sh
#!/bin/bash

# Get the GPU metrics
gpu_utilization=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits)
temperature_gpu=$(nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits)
power_draw=$(nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits)
utilization_memory=$(nvidia-smi --query-gpu=utilization.memory --format=csv,noheader,nounits)
fan_speed=$(nvidia-smi --query-gpu=fan.speed --format=csv,noheader,nounits)
memory_total=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits)
memory_used=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits)
memory_free=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits)

# Get current instance region
region=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)

# Get the Instance ID from the EC2 metadata
instance_id=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)

# Publish the GPU metrics to CloudWatch
aws cloudwatch put-metric-data --namespace "Custom/GPU" --metric-name "GPUUtilization" \
--value $gpu_utilization --dimensions InstanceId=$instance_id --unit Percent --region $region

aws cloudwatch put-metric-data --namespace "Custom/GPU" --metric-name "TemperatureGPU" \
--value $temperature_gpu --dimensions InstanceId=$instance_id --unit Celsius --region $region

aws cloudwatch put-metric-data --namespace "Custom/GPU" --metric-name "PowerDraw" \
--value $power_draw --dimensions InstanceId=$instance_id --unit Watts --region $region

aws cloudwatch put-metric-data --namespace "Custom/GPU" --metric-name "MemoryUtilization" \
--value $utilization_memory --dimensions InstanceId=$instance_id --unit Percent --region $region

aws cloudwatch put-metric-data --namespace "Custom/GPU" --metric-name "FanSpeed" \
--value $fan_speed --dimensions InstanceId=$instance_id --unit Percent --region $region

aws cloudwatch put-metric-data --namespace "Custom/GPU" --metric-name "MemoryTotal" \
--value $memory_total --dimensions InstanceId=$instance_id --unit Megabytes --region $region

aws cloudwatch put-metric-data --namespace "Custom/GPU" --metric-name "MemoryUsed" \
--value $memory_used --dimensions InstanceId=$instance_id --unit Megabytes --region $region

aws cloudwatch put-metric-data --namespace "Custom/GPU" --metric-name "MemoryFree" \
--value $memory_free --dimensions InstanceId=$instance_id --unit Megabytes --region $region

EOF

# Make the script executable
chmod +x /opt/gpu-monitoring.sh

# Setup a cron job to run the script every minute
(crontab -l 2>/dev/null; echo "* * * * * /opt/gpu-monitoring.sh") | crontab -

